// Secrets shorter than 4 characters are not redacted from text: replacing
// every "731" or "ab" in the evidence would corrupt it (step counts, ports,
// timestamps, selectors) and the pattern of replacements would itself point
// at the value. The gap is made visible instead: a warning when the suite is
// loaded, and a limitation on every result of the run.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { suiteEvidencePolicy, suiteSchema } from '../src/contracts.js';
import { evidencePolicySchema } from '../src/evidence/policy.js';
import { evidenceProtection } from '../src/evidence/protection.js';
import { Redactor } from '../src/evidence/redact.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { notesFixture } from '../examples/notes-fixture.js';
import { STATE_SCRIPTS, scriptedDecisions } from '../examples/state-fixture.js';

const web = {
  platform: 'web' as const,
  authenticated: false,
  videoRequested: false,
};

test('a declared secret too short to redact is reported by name, never by value', () => {
  const env = {
    UIUX_SHORT_PIN: '731',
    UIUX_LONG_SECRET: 'long-enough-value',
    UIUX_EMPTY: '',
    PLANNER_API_HEADERS: JSON.stringify({ 'x-gw': 'k9' }),
  };
  const redactor = new Redactor({
    envNames: ['UIUX_SHORT_PIN', 'UIUX_LONG_SECRET', 'UIUX_EMPTY', 'UIUX_UNSET'],
    env,
  });
  // Unchanged behaviour: short values are left in text, longer ones redacted.
  assert.equal(redactor.text('pin 731'), 'pin 731');
  assert.equal(
    redactor.text('long-enough-value'),
    '[REDACTED:env:UIUX_LONG_SECRET]',
  );
  // Empty and unset variables hold nothing to leak.
  assert.deepEqual(redactor.tooShort, [
    'UIUX_SHORT_PIN',
    'PLANNER_API_HEADERS.x-gw',
  ]);

  const protection = evidenceProtection(
    evidencePolicySchema.parse({ redactEnv: ['UIUX_SHORT_PIN'] }),
    env,
    web,
  );
  const { limitations } = protection.report(0);
  assert.equal(limitations.length, 2);
  assert.match(
    limitations[0]!,
    /^UIUX_SHORT_PIN: its value is shorter than 4 characters and is not redacted from text evidence/,
  );
  for (const line of limitations) {
    assert.doesNotMatch(line, /731|k9/);
  }
});

test('a setup value too short to redact is a limitation of that run only', () => {
  const protection = evidenceProtection(
    evidencePolicySchema.parse({}),
    {},
    web,
  );
  protection.beginRun({ pin: '12', owner: 'owner-long-1' }, []);
  let report = protection.report(0);
  assert.deepEqual(report.redactedData, ['owner']);
  assert.equal(report.limitations.length, 1);
  assert.match(
    report.limitations[0]!,
    /^dataLifecycle setup value data\.pin: its value is shorter than 4 characters and is not redacted from text evidence/,
  );
  assert.doesNotMatch(report.limitations[0]!, /12/);
  // A public value is not a secret, so it is not a limitation.
  protection.beginRun({ pin: '34' }, ['pin']);
  report = protection.report(0);
  assert.deepEqual([report.redactedData, report.limitations], [[], []]);
});

test('a run with a short declared secret lists the limitation in results, the report and the event log', async () => {
  const app = await notesFixture();
  try {
    const raw = JSON.parse(
      await readFile(
        new URL('../examples/notes.json', import.meta.url),
        'utf8',
      ),
    );
    const suite = suiteSchema.parse({
      ...JSON.parse(
        JSON.stringify(raw).replace(/http:\/\/127\.0\.0\.1:4174/g, app.url),
      ),
      evidence: { redactEnv: ['UIUX_SHORT_PIN'] },
    });
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-short-secret-')),
      'run',
    );
    const [result] = await runSuite(suite, scriptedDecisions(STATE_SCRIPTS), {
      directory,
      env: { UIUX_SHORT_PIN: 'q7' },
    });
    assert.equal(result!.status, 'passed', result!.reason);
    const [recorded] = parseResults(
      await readFile(join(directory, 'results.json'), 'utf8'),
    );
    assert.equal(recorded!.evidence.limitations.length, 1);
    assert.match(recorded!.evidence.limitations[0]!, /^UIUX_SHORT_PIN: /);
    const report = await readFile(join(directory, 'report.html'), 'utf8');
    assert.match(report, /1 protection limitation/);
    assert.match(report, /UIUX_SHORT_PIN: its value is shorter than 4 characters/);
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    const policy = events
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'evidence_policy');
    assert.equal(policy.data.limitations.length, 1);
  } finally {
    await app.close();
  }
});

test('the CLI warns when it loads a suite whose declared secret is too short to redact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-short-secret-cli-'));
  const file = join(directory, 'suite.json');
  const raw = JSON.parse(
    await readFile(new URL('../examples/website.json', import.meta.url), 'utf8'),
  );
  await writeFile(
    file,
    JSON.stringify({ ...raw, evidence: { redactEnv: ['UIUX_SHORT_PIN'] } }),
  );
  // Parsed the same way the CLI does: the warning names the suite's variable.
  assert.deepEqual(
    suiteEvidencePolicy(suiteSchema.parse(JSON.parse(await readFile(file, 'utf8'))))
      .redactEnv,
    ['UIUX_SHORT_PIN'],
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--suite', file, '--validate'],
    { env: { ...process.env, UIUX_SHORT_PIN: 'x1' } },
  );
  assert.match(stdout, /Valid suite/);
  assert.match(
    stderr,
    /Warning: UIUX_SHORT_PIN: its value is shorter than 4 characters and is not redacted from text evidence/,
  );
  assert.doesNotMatch(stderr, /x1/);
  const quiet = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--suite', file, '--validate'],
    { env: { ...process.env, UIUX_SHORT_PIN: 'long-enough-pin' } },
  );
  assert.equal(quiet.stderr, '');
});
