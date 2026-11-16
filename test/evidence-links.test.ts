// The report links every evidence file it shows even when the run's redaction
// rewrote the recorded path (results.json is redacted text), and never prints
// the secret that was redacted. Local notes fixture, scripted decisions, no
// model calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { suiteSchema, type Suite } from '../src/contracts.js';
import {
  UNRESOLVED_LINK,
  evidenceLinks,
  fileHref,
} from '../src/evidence/links.js';
import { Redactor } from '../src/evidence/redact.js';
import { runSuite } from '../src/runner.js';
import { isPrivate } from '../src/evidence/private.js';
import { notesFixture } from '../examples/notes-fixture.js';
import { STATE_SCRIPTS, scriptedDecisions } from '../examples/state-fixture.js';

async function notesSuite(
  url: string,
  overrides: Record<string, unknown>,
): Promise<Suite> {
  const raw = JSON.parse(
    await readFile(new URL('../examples/notes.json', import.meta.url), 'utf8'),
  );
  return suiteSchema.parse({
    ...JSON.parse(
      JSON.stringify(raw).replace(/http:\/\/127\.0\.0\.1:4174/g, url),
    ),
    ...overrides,
  });
}

// Every local href/src in the report, decoded.
function localLinks(html: string): string[] {
  return [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)]
    .map((match) =>
      match[1]!
        .replaceAll('&amp;', '&')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"'),
    )
    .filter((link) => !/^(?:[a-z]+:|#)/i.test(link));
}

async function assertLinksResolve(directory: string, secret: string) {
  const html = await readFile(join(directory, 'report.html'), 'utf8');
  assert.ok(!html.includes(secret), 'the report prints the redacted secret');
  const links = localLinks(html);
  assert.ok(links.length > 0, 'the report links its evidence');
  for (const link of links) {
    assert.ok(!link.includes('REDACTED'), `${link} is a redacted path`);
    const target = resolve(directory, link);
    assert.ok(
      !relative(directory, target).startsWith('..'),
      `${link} leaves the run directory`,
    );
    assert.ok((await stat(target)).isFile(), `${link} does not resolve`);
  }
  return links;
}

test(
  'a file on another drive is linked by its file: URL, not as a relative path',
  { skip: process.platform !== 'win32' && 'drives exist on Windows only' },
  () => {
    const run = 'C:\\runs\\demo';
    assert.equal(fileHref(run, `${run}\\j\\step-001.png`), 'j/step-001.png');
    assert.equal(
      fileHref(run, 'C:\\baselines\\a b.png'),
      '../../baselines/a b.png',
    );
    assert.equal(
      fileHref(run, 'D:\\baselines\\a b.png'),
      'file:///D:/baselines/a%20b.png',
    );
  },
);

test('report links resolve when a secret is part of the run directory path', async () => {
  const app = await notesFixture();
  try {
    // The run directory's parent name is a secret value of the run: every
    // path recorded in the results is redacted.
    const parent = await mkdtemp(join(tmpdir(), 'ui-ux-link-tag-'));
    const tag = basename(parent);
    const directory = join(parent, 'run');
    const [result] = await runSuite(
      await notesSuite(app.url, { evidence: { redactEnv: ['UIUX_TEST_RUN_TAG'] } }),
      scriptedDecisions(STATE_SCRIPTS),
      { directory, env: { UIUX_TEST_RUN_TAG: tag } },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    assert.match(
      result!.outcome.evidence.screenshot ?? '',
      /\[REDACTED:env:UIUX_TEST_RUN_TAG\]/,
    );
    const links = await assertLinksResolve(directory, tag);
    // Inside the run, the path holds no secret: linked where it is.
    assert.ok(links.some((link) => link.startsWith('save-note-desktop/')));
  } finally {
    await app.close();
  }
});

test('report links resolve, without the secret, when it is part of a path inside the run', async () => {
  const app = await notesFixture();
  try {
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-link-inner-')),
      'run',
    );
    // The viewport name matches the suite's own pattern, so the journey
    // directory name is redacted in every recorded path.
    const [result] = await runSuite(
      await notesSuite(app.url, {
        viewports: [{ name: 'case-482913', width: 1280, height: 800 }],
        evidence: { redact: [{ pattern: 'case-\\d{6}', label: 'case-id' }] },
      }),
      scriptedDecisions(STATE_SCRIPTS),
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    assert.match(
      result!.outcome.evidence.screenshot ?? '',
      /save-note-\[REDACTED:case-id\]/,
    );
    const links = await assertLinksResolve(directory, '482913');
    // Linked through a copy named by its content, not by the secret path.
    const deciding = links.find((link) => link.startsWith('evidence-links/'));
    assert.ok(deciding, 'the screenshot is linked through an alias');
    const real = join(
      directory,
      'save-note-case-482913',
      basename(result!.outcome.evidence.screenshot!),
    );
    assert.deepEqual(
      await readFile(resolve(directory, deciding)),
      await readFile(real),
    );
    // Evidence stays private.
    assert.ok(await isPrivate(resolve(directory, deciding), 'file'));
  } finally {
    await app.close();
  }
});

test('a redacted path that names several files is not linked, and files outside the run are copied, not linked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-link-unit-'));
  for (const name of ['case-111111', 'case-222222', 'case-333333-only']) {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, 'x.png'), name);
  }
  const outside = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-link-baselines-')),
    'case-444444',
  );
  await mkdir(outside);
  await writeFile(join(outside, 'b.png'), 'baseline');
  const redactor = new Redactor({ patterns: [{ pattern: 'case-\\d{6}' }] });
  const recorded = (path: string) => redactor.text(path);
  const ambiguous = recorded(join(directory, 'case-111111', 'x.png'));
  const unique = recorded(join(directory, 'case-333333-only', 'x.png'));
  const baseline = recorded(join(outside, 'b.png'));
  const links = await evidenceLinks(
    directory,
    redactor,
    [ambiguous, unique, baseline, join(directory, 'gone-[REDACTED]', 'x.png')],
    [outside],
  );
  assert.equal(links.get(ambiguous), UNRESOLVED_LINK);
  assert.equal(
    links.get(join(directory, 'gone-[REDACTED]', 'x.png')),
    UNRESOLVED_LINK,
  );
  const inside = links.get(unique)!;
  assert.match(inside, /^evidence-links\/[0-9a-f]{16}\.png$/);
  assert.equal(
    (await stat(join(directory, inside))).ino,
    (await stat(join(directory, 'case-333333-only', 'x.png'))).ino,
    'a file inside the run is hard-linked',
  );
  const copied = links.get(baseline)!;
  assert.match(copied, /^evidence-links\/[0-9a-f]{16}\.png$/);
  assert.notEqual(
    (await stat(join(directory, copied))).ino,
    (await stat(join(outside, 'b.png'))).ino,
  );
  assert.equal(await readFile(join(directory, copied), 'utf8'), 'baseline');
  for (const link of links.values())
    assert.doesNotMatch(link, /111111|222222|333333|444444/);
});
