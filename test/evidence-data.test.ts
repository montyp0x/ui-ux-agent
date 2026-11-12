// Values returned by data-lifecycle setup ({{data.<key>}}) are secrets by
// default: redacted from every text evidence path like redactEnv values,
// masked in screenshots, and they make the suite sensitive so traces and video
// stay off. dataLifecycle.publicValues opts named keys out. Local notes
// fixture, scripted decisions, no model calls.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
  suiteEvidencePolicy,
  suiteSchema,
  type Suite,
} from '../src/contracts.js';
import { protectedScreenshot } from '../src/drivers/playwright-evidence.js';
import { evidenceFormats, sensitive } from '../src/evidence/policy.js';
import { evidenceProtection } from '../src/evidence/protection.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { notesFixture } from '../examples/notes-fixture.js';
import { STATE_SCRIPTS, scriptedDecisions } from '../examples/state-fixture.js';
import { pixelCounts } from './evidence-fixtures.js';

async function notesSuite(
  url: string,
  overrides: {
    journey?: Record<string, unknown>;
    dataLifecycle?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
  } = {},
): Promise<Suite> {
  const raw = JSON.parse(
    await readFile(new URL('../examples/notes.json', import.meta.url), 'utf8'),
  );
  const local = JSON.parse(
    JSON.stringify(raw).replace(/http:\/\/127\.0\.0\.1:4174/g, url),
  );
  local.journeys[0] = { ...local.journeys[0], ...overrides.journey };
  local.dataLifecycle = { ...local.dataLifecycle, ...overrides.dataLifecycle };
  if (overrides.evidence) local.evidence = overrides.evidence;
  return suiteSchema.parse(local) as Suite;
}

// The notes journey, typing the setup value into the note as well.
const typedOwner = {
  interactions: [
    {
      kind: 'fill',
      target: { by: 'label', value: 'Note' },
      value: 'Note {{marker}} by {{data.owner}}',
      description: 'Write the note',
    },
    {
      kind: 'click',
      target: { by: 'role', role: 'button', name: 'Save note' },
      description: 'Save the note',
    },
  ],
};

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}

const runDirectory = async () =>
  join(await mkdtemp(join(tmpdir(), 'ui-ux-data-secrets-')), 'run');

test('dataLifecycle.publicValues is validated: data keys, unique, at most 20', async () => {
  const url = 'http://127.0.0.1:4174';
  assert.deepEqual(
    (await notesSuite(url)).dataLifecycle?.publicValues,
    [],
    'every setup value is secret by default',
  );
  await assert.rejects(
    notesSuite(url, { dataLifecycle: { publicValues: ['not a key'] } }),
  );
  await assert.rejects(
    notesSuite(url, { dataLifecycle: { publicValues: ['owner', 'owner'] } }),
    /unique/,
  );
  await assert.rejects(
    notesSuite(url, {
      dataLifecycle: {
        publicValues: Array.from({ length: 21 }, (_, i) => `k${i}`),
      },
    }),
  );
  const open = await notesSuite(url, {
    dataLifecycle: { publicValues: ['owner'] },
  });
  assert.deepEqual(open.dataLifecycle?.publicValues, ['owner']);
});

test('a journey that uses a secret setup value makes the suite sensitive and masks the field it is typed into', async () => {
  const url = 'http://127.0.0.1:4174';
  const context = {
    platform: 'web' as const,
    authenticated: false,
    videoRequested: true,
  };
  // The reference notes journey reads {{data.owner}} in its start path.
  const secret = suiteEvidencePolicy(await notesSuite(url));
  assert.equal(sensitive(secret), true);
  const formats = Object.fromEntries(
    evidenceFormats(secret, context).map((entry) => [entry.format, entry]),
  );
  assert.equal(formats.trace!.enabled, false);
  assert.equal(formats.video!.enabled, false);
  assert.deepEqual(secret.masks, [], 'nothing is typed from data');

  const typed = suiteEvidencePolicy(
    await notesSuite(url, { journey: typedOwner }),
  );
  assert.deepEqual(typed.masks, [{ by: 'label', value: 'Note' }]);

  // An unsanitizable trace is refused at load, as for valueEnv.
  await assert.rejects(
    notesSuite(url, { evidence: { trace: 'local' } }),
    /evidence\.trace: 'local' cannot be sanitized and this suite uses secret dataLifecycle setup values \(owner\)/,
  );

  // Public values are ordinary journey text.
  const open = suiteEvidencePolicy(
    await notesSuite(url, {
      journey: typedOwner,
      dataLifecycle: { publicValues: ['owner'] },
      evidence: { trace: 'local' },
    }),
  );
  assert.equal(sensitive(open), false);
  assert.deepEqual(open.masks, []);
});

test('setup values are redacted from text and masked in screenshots once a run learns them', async () => {
  const OWNER = 'owner-fixture-4417';
  const protection = evidenceProtection(
    suiteEvidencePolicy(await notesSuite('http://127.0.0.1:4174')),
    {},
    { platform: 'web', authenticated: false, videoRequested: false },
  );
  assert.equal(protection.redactor.text(`as ${OWNER}`), `as ${OWNER}`);
  protection.beginRun({ owner: OWNER, team: 'team-public-1' }, ['team']);
  assert.equal(
    protection.redactor.text(`Signed in as ${OWNER}`),
    'Signed in as [REDACTED:data:owner]',
  );
  assert.equal(protection.redactor.text('team-public-1'), 'team-public-1');
  const report = protection.report(0);
  assert.deepEqual(report.redactedData, ['owner']);
  assert.deepEqual(report.redactedEnv, [], 'data keys are not env names');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 400 },
    });
    const decoder = await browser.newPage();
    await page.setContent(`<!doctype html><body style="font:32px sans-serif;color:#333;background:#fff">
      <p style="color:#f00">${OWNER}</p>
      <input style="color:#f00;font-size:32px;width:600px" value="Note by ${OWNER}">
    </body>`);
    assert.ok((await pixelCounts(decoder, await page.screenshot())).red > 500);
    // The session holds the protection object from before the run began.
    const masked = await pixelCounts(
      decoder,
      await protectedScreenshot(page, protection.screenshots),
    );
    assert.equal(masked.red, 0, 'the setup value is masked');
    assert.ok(masked.mask > 500);
  } finally {
    await browser.close();
  }
});

test('setup values never reach run evidence; traces and video stay off', async () => {
  const app = await notesFixture();
  try {
    const directory = await runDirectory();
    const [result] = await runSuite(
      await notesSuite(app.url, { journey: typedOwner }),
      scriptedDecisions(STATE_SCRIPTS),
      { directory, video: true },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    const owner = `owner-${result!.marker!.toLowerCase()}`;
    const written = await files(directory);
    assert.ok(written.some((path) => path.endsWith('events.jsonl')));
    for (const path of written)
      assert.ok(
        !(await readFile(path)).toString('latin1').includes(owner),
        `the setup value is in ${path}`,
      );
    assert.ok(!written.some((path) => /\.(zip|webm)$/.test(path)));
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.ok(events.includes('[REDACTED:data:owner]'));
    const [recorded] = parseResults(
      await readFile(join(directory, 'results.json'), 'utf8'),
    );
    assert.equal(recorded!.trace, null);
    assert.deepEqual(recorded!.evidence.redactedData, ['owner']);
    assert.deepEqual(recorded!.dataLifecycle!.values, ['owner']);
  } finally {
    await app.close();
  }
});

test('public setup values are kept, and the trace is captured', async () => {
  const app = await notesFixture();
  try {
    const directory = await runDirectory();
    const [result] = await runSuite(
      await notesSuite(app.url, { dataLifecycle: { publicValues: ['owner'] } }),
      scriptedDecisions(STATE_SCRIPTS),
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    const owner = `owner-${result!.marker!.toLowerCase()}`;
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.ok(events.includes(owner));
    assert.deepEqual(result!.evidence.redactedData, []);
    assert.ok(result!.trace?.endsWith('trace.zip'));
  } finally {
    await app.close();
  }
});
