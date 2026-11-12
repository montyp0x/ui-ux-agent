// The example state-coverage and keyboard-only suites (examples/states.json,
// examples/keyboard.json) against the local state fixture, with scripted
// decisions: every declared state is reached and passes its own checks, and
// each page's deliberate defect fails exactly its state's checks while the
// journey's functional outcome is unchanged. No model calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { suiteSchema, type Suite } from '../src/contracts.js';
import { runSuite } from '../src/runner.js';
import {
  STATE_SCRIPTS,
  scriptedDecisions,
  stateFixture,
  type StateFixture,
} from '../examples/state-fixture.js';

let fixture: StateFixture;
before(async () => {
  fixture = await stateFixture();
});
after(async () => {
  await fixture?.close();
});

type RawSuite = {
  journeys: { id: string; startPath: string; maxSteps?: number }[];
};
async function example(
  file: string,
  edit: (raw: RawSuite) => void = () => {},
): Promise<Suite> {
  const raw = JSON.parse(
    await readFile(new URL(`../examples/${file}`, import.meta.url), 'utf8'),
  ) as RawSuite;
  edit(raw);
  return suiteSchema.parse({ ...raw, baseURL: fixture.url }) as Suite;
}
const run = async (suite: Suite) =>
  runSuite(suite, scriptedDecisions(STATE_SCRIPTS), {
    directory: join(await mkdtemp(join(tmpdir(), 'ui-ux-states-')), 'run'),
  });

test('every example journey reaches each declared state and the state passes its own checks', async () => {
  for (const file of ['states.json', 'keyboard.json']) {
    const suite = await example(file);
    const results = await run(suite);
    for (const result of results) {
      const journey = suite.journeys.find((entry) => entry.id === result.journey)!;
      assert.equal(result.status, 'passed', `${result.journey}: ${result.reason}`);
      assert.deepEqual(result.audits.notReached, [], result.journey);
      const stateRuns = result.audits.runs.filter(
        (entry) => entry.auditId === 'journey.state-checks',
      );
      assert.deepEqual(
        stateRuns.map((entry) => [entry.checkpoint.name, entry.status]),
        (journey.states ?? []).map((state) => [state.name, 'clean']),
        result.journey,
      );
      assert.equal(result.quality.verdict, 'pass', `${result.journey}: ${result.quality.reason}`);
    }
  }
});

test('each page defect fails its own state checks while the journey still passes', async () => {
  const expected: Record<string, string> = {
    'form-validation': 'validation-error',
    'items-empty': 'empty',
    'dialog-edit': 'dialog-open',
    'menu-archive': 'menu-open',
    'table-pagination': 'last-page',
    'wizard-steps': 'step-2',
  };
  const suite = await example('states.json', (raw) => {
    raw.journeys = raw.journeys.filter((journey) => journey.id in expected);
    for (const journey of raw.journeys)
      journey.startPath += journey.startPath.includes('?')
        ? '&defect=1'
        : '?defect=1';
  });
  const results = await run(suite);
  assert.equal(results.length, Object.keys(expected).length);
  for (const result of results) {
    assert.equal(result.status, 'passed', `${result.journey}: ${result.reason}`);
    assert.equal(result.quality.verdict, 'fail', result.journey);
    const failed = result.audits.findings.filter(
      (finding) => finding.auditId === 'journey.state-checks',
    );
    assert.deepEqual(
      [...new Set(failed.map((finding) => finding.reproduction.checkpoint))],
      [`state:${expected[result.journey]}`],
      result.journey,
    );
    assert.ok(failed.every((finding) => finding.gating));
  }
});

test('a dialog that does not take focus stops the keyboard-only example and is reported', async () => {
  const suite = await example('keyboard.json', (raw) => {
    raw.journeys[0]!.startPath += '?defect=1';
    raw.journeys[0]!.maxSteps = 4;
  });
  const [result] = await run(suite);
  // The keyboard user cannot reach the field, so the goal is not reached.
  assert.notEqual(result!.status, 'passed');
  assert.deepEqual(
    result!.audits.findings
      .filter((finding) => finding.certainty === 'violation')
      .map((finding) => [finding.auditId, finding.ruleId]),
    [
      ['journey.state-checks', 'state-expectation'],
      ['keyboard.focus', 'dialog-initial-focus'],
    ],
  );
});
