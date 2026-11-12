// Outcome classification and quality verdicts, run against an in-memory driver
// so every scenario is deterministic and needs no browser or model.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  suiteSchema,
  type Action,
  type Observation,
} from '../src/contracts.js';
import type { UIDriver, UISession } from '../src/drivers/types.js';
import type { Models } from '../src/models.js';
import { evaluateQuality } from '../src/quality.js';
import { reportHTML } from '../src/report.js';
import { parseResults, type OutcomeCode, type Result } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { computeFriction, eventLogRuns } from '../src/friction/index.js';

type Scenario = {
  platform?: 'web' | 'macos';
  ready?: boolean;
  // Executed actions after which the success assertion holds.
  successAfter?: number;
  // The page changes after each action, so loop detection does not trigger.
  changes?: boolean;
  overflow?: number;
  unauthorized?: boolean;
  outOfScope?: boolean;
  executeError?: string;
  candidatesError?: string;
  screenshotError?: string;
  browserErrors?: string[];
  policyBlocks?: string[];
  setup?: boolean;
  maxSteps?: number;
  choose?: (actions: Action[]) => Promise<string> | string;
};

const continueAction: Extract<Action, { kind: 'click' }> = {
  kind: 'click',
  id: 'a0',
  description: 'Continue',
  target: { by: 'role', role: 'button', name: 'Continue' },
};

function fakeDriver(scenario: Scenario): UIDriver {
  return {
    async openSession(): Promise<UISession> {
      let executed = 0;
      let observed = 0;
      return {
        browserErrors: scenario.browserErrors ?? [],
        policyBlocks: scenario.policyBlocks ?? [],
        get unauthorized() {
          return !!scenario.unauthorized && observed > 0;
        },
        async start() {},
        setTimeout() {},
        location: () => 'https://app.example/',
        async check(condition) {
          if (condition.kind === 'visible') return scenario.ready ?? true;
          return executed >= (scenario.successAfter ?? Infinity);
        },
        async observe(step, screenshot): Promise<Observation> {
          observed++;
          return {
            step,
            url:
              executed >= (scenario.successAfter ?? Infinity)
                ? 'https://app.example/done'
                : 'https://app.example/',
            snapshot: '- button "Continue"',
            screenshot,
            visibleViewport: {
              width: 800,
              height: 600,
              text: 'Continue',
              textTruncated: false,
              controls: [{ role: 'button', name: 'Continue', disabled: false }],
              canScrollUp: false,
              canScrollDown: false,
              scrollRegions: [],
            },
            fingerprint: scenario.changes ? `state-${executed}` : 'state',
            scroll: { x: 0, y: 0, containers: [] },
            horizontalOverflow: scenario.overflow ?? 0,
          };
        },
        async candidates() {
          if (scenario.candidatesError)
            throw new Error(scenario.candidatesError);
          return [{ ...continueAction }];
        },
        async execute() {
          if (scenario.executeError) throw new Error(scenario.executeError);
          executed++;
        },
        async screenshot() {
          if (scenario.screenshotError)
            throw new Error(scenario.screenshotError);
        },
        async inScope() {
          return !scenario.outOfScope;
        },
        async finish() {
          return { video: null, trace: 'trace.json' };
        },
      };
    },
    async close() {},
  };
}

async function run(scenario: Scenario, driver?: UIDriver) {
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-outcome-')),
    'run',
  );
  const models: Models = {
    async plan() {
      return { objective: 'Continue', concerns: [] };
    },
    async choose(_journey, _observation, _plan, actions) {
      const choice = scenario.choose
        ? await scenario.choose(actions)
        : actions[0]!.id;
      return {
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: { [choice]: 1 },
      };
    },
  };
  const suite = suiteSchema.parse({
    name: 'Outcome fixture',
    ...(scenario.platform === 'macos'
      ? { platform: 'macos', app: { bundleId: 'com.example.fixture' } }
      : {
          baseURL: 'https://app.example',
          viewports: [{ name: 'desktop', width: 800, height: 600 }],
        }),
    journeys: [
      {
        id: 'finish',
        goal: 'Finish',
        persona: 'Visitor',
        ...(scenario.platform === 'macos'
          ? {}
          : { startPath: '/', allowedPaths: ['/', '/done'] }),
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Start' },
        },
        success: [{ kind: 'path', pattern: '^/done$' }],
        interactions: [
          {
            kind: 'click',
            target: continueAction.target,
            description: 'Continue',
          },
        ],
        ...(scenario.setup
          ? {
              setup: [
                {
                  kind: 'click',
                  target: continueAction.target,
                  description: 'Reset',
                },
              ],
            }
          : {}),
        maxSteps: scenario.maxSteps ?? 20,
        maxDurationMs: 1000,
      },
    ],
  });
  const [result] = await runSuite(suite, models, {
    directory,
    driver: driver ?? fakeDriver(scenario),
  });
  // results.json is parsed through the published contract, so every scenario
  // also proves that its status and outcome code agree.
  const [stored] = parseResults(
    await readFile(join(directory, 'results.json'), 'utf8'),
  );
  assert.deepEqual(stored, result);
  const report = await readFile(join(directory, 'report.html'), 'utf8');
  return { result: result!, report, directory };
}

const classification = (result: Result) => [
  result.status,
  result.outcome.code,
  result.outcome.category,
  result.outcome.source,
];

const cases: [
  string,
  Scenario,
  [Result['status'], OutcomeCode, string, string],
][] = [
  [
    'independent assertions passing',
    { successAfter: 1 },
    ['passed', 'assertions_passed', 'passed', 'assertion'],
  ],
  [
    'an unmet ready assertion',
    { ready: false },
    ['blocked', 'ready_not_reached', 'precondition_failure', 'unknown'],
  ],
  [
    'a stale setup action',
    {
      setup: true,
      executeError: 'Stale observation: selected target changed',
    },
    ['blocked', 'setup_stale_action', 'stale_action', 'harness'],
  ],
  [
    'a failing setup action',
    { setup: true, executeError: 'click failed' },
    ['blocked', 'setup_action_failed', 'precondition_failure', 'unknown'],
  ],
  [
    'an unauthorized response',
    { unauthorized: true },
    ['blocked', 'unauthorized_response', 'auth_failure', 'environment'],
  ],
  [
    'leaving the journey scope',
    { outOfScope: true },
    ['blocked', 'scope_exit', 'policy_block', 'harness'],
  ],
  [
    'repeating one action in one state',
    {},
    ['failed', 'repeated_action', 'agent_loop', 'agent'],
  ],
  [
    'running out of steps',
    { changes: true, maxSteps: 2 },
    ['failed', 'budget_max_steps', 'budget_exhausted', 'unknown'],
  ],
  [
    'a selector that finds no path',
    { choose: () => 'no_match' },
    ['failed', 'selector_no_path', 'agent_no_path', 'agent'],
  ],
  [
    'a failed model call',
    {
      choose: () => {
        throw new Error('Model HTTP 500');
      },
    },
    ['error', 'model_call_failed', 'model_error', 'model'],
  ],
  [
    // Mirrors models.ts RateLimitBudgetError on uiux/0b-limiter, matched by name.
    'a rate-limit cooldown that would pass the deadline',
    {
      choose: () => {
        class RateLimitBudgetError extends Error {}
        throw new RateLimitBudgetError(
          'Model request would wait 30s for its rate limit, past the step budget',
        );
      },
    },
    ['failed', 'budget_model_rate_limit', 'budget_exhausted', 'model'],
  ],
  [
    'a selector choice that was not offered',
    { choose: () => 'a99' },
    ['error', 'model_invalid_output', 'model_error', 'model'],
  ],
  [
    'a driver failure',
    { candidatesError: 'Target page, context or browser has been closed' },
    ['error', 'driver_error', 'infrastructure_error', 'unknown'],
  ],
  [
    'an evidence capture failure',
    { successAfter: 1, screenshotError: 'disk full' },
    ['error', 'evidence_capture_failed', 'infrastructure_error', 'unknown'],
  ],
];

for (const [name, scenario, expected] of cases)
  test(`outcome classification: ${name}`, async () => {
    const { result } = await run(scenario);
    assert.deepEqual(classification(result), expected, result.reason);
  });

test('a repeated failure reproduces the same reason code and evidence references', async () => {
  const [first, second] = [await run({}), await run({})];
  const stable = ({ result }: { result: Result }) => ({
    ...result.outcome,
    evidence: {
      ...result.outcome.evidence,
      screenshot: result.outcome.evidence.screenshot?.split('/').pop(),
    },
  });
  assert.deepEqual(stable(first), stable(second));
  const { outcome, findings } = first.result;
  assert.equal(outcome.stage, 'loop_check');
  assert.deepEqual(outcome.evidence.events, ['loop_check']);
  assert.deepEqual(outcome.evidence.failedChecks, [0]);
  assert.equal(outcome.detail, 'Continue');
  assert.match(outcome.evidence.screenshot ?? '', /step-\d{3}\.png$/);
  assert.ok(findings.some((finding) => finding.category === 'loop'));
});

test('a loop or exhausted budget is not reported as product evidence', async () => {
  for (const scenario of [{}, { changes: true, maxSteps: 2 }]) {
    const { result, report } = await run(scenario);
    assert.notEqual(result.outcome.source, 'assertion');
    assert.match(report, /not by itself evidence of a product defect/);
    // Unrelated to the stop: measured quality is still reported on its own.
    assert.equal(result.quality.verdict, 'pass');
  }
});

test('budget evidence names the false assertions and the step', async () => {
  const { result } = await run({ changes: true, maxSteps: 2 });
  assert.equal(result.outcome.step, 2);
  assert.deepEqual(result.outcome.evidence.failedChecks, [0]);
  assert.deepEqual(result.outcome.evidence.events, ['observation']);
});

test('stale actions during a journey are counted as signals, not as the cause', async () => {
  const { result } = await run({
    executeError: 'Stale observation: navigation changed during selection',
    maxSteps: 3,
    changes: true,
  });
  assert.equal(result.outcome.category, 'budget_exhausted');
  assert.ok(result.outcome.signals.staleActions >= 1);
  assert.equal(result.outcome.signals.actionErrors, 0);
});

test('the functional outcome is kept when a quality check fails', async () => {
  const { result, report } = await run({ successAfter: 1, overflow: 40 });
  assert.equal(result.status, 'passed');
  assert.equal(result.outcome.code, 'assertions_passed');
  assert.equal(result.quality.verdict, 'fail');
  const overflow = result.quality.executed.find(
    (check) => check.id === 'layout.horizontal-overflow',
  )!;
  assert.equal(overflow.status, 'failed');
  assert.equal(overflow.source, 'audit');
  // The overflow check is an audit at completion now, not a run finding.
  const finding = result.audits.findings[overflow.audit!.findings[0]!]!;
  assert.equal(finding.ruleId, 'document-wider-than-viewport');
  assert.equal(finding.certainty, 'violation');
  assert.equal(finding.gating, true);
  assert.equal(finding.reproduction.checkpoint, 'completion');
  assert.equal(finding.reproduction.step, 0);
  assert.match(finding.description, /40px wider than the viewport/);
  assert.ok(!result.findings.some((entry) => entry.category === 'overflow'));
  // The final, passing state is measured too.
  assert.equal(overflow.observations, 2);
  assert.match(report, /<strong>PASSED<\/strong>/);
  assert.match(report, /<strong>QUALITY FAIL<\/strong>/);
  assert.match(report, /0 pass, 1 fail, 0 not evaluated/);
});

test('runtime errors fail quality unless the request policy may explain them', async () => {
  const errors = {
    successAfter: 1,
    browserErrors: ['TypeError: x is undefined'],
  };
  const plain = (await run(errors)).result;
  assert.equal(plain.status, 'passed');
  assert.equal(plain.quality.verdict, 'fail');
  const confounded = (
    await run({ ...errors, policyBlocks: ['POST https://app.example/api'] })
  ).result;
  assert.equal(confounded.status, 'passed');
  assert.equal(confounded.quality.verdict, 'not_evaluated');
  assert.equal(
    confounded.quality.executed.find(
      (check) => check.id === 'runtime.browser-errors',
    )!.status,
    'inconclusive',
  );
  assert.equal(confounded.outcome.signals.policyBlocks, 1);
});

test('zero executed quality checks is not evaluated, never a pass', async () => {
  const blocked = await run({ ready: false });
  assert.equal(blocked.result.quality.verdict, 'not_evaluated');
  assert.deepEqual(blocked.result.quality.executed, []);
  assert.deepEqual(
    blocked.result.quality.skipped.map((gap) => gap.id),
    ['layout.horizontal-overflow', 'runtime.browser-errors'],
  );
  assert.match(blocked.report, /QUALITY NOT EVALUATED/);

  const native = await run({ platform: 'macos', successAfter: 1 });
  assert.equal(native.result.status, 'passed');
  assert.equal(native.result.quality.verdict, 'not_evaluated');
  assert.ok(
    native.result.quality.unsupported.some(
      (gap) => gap.id === 'layout.horizontal-overflow',
    ),
  );
});

test('an evidence failure marks the runtime check errored instead of clean', async () => {
  const { result } = await run({
    successAfter: 1,
    screenshotError: 'disk full',
  });
  assert.match(result.outcome.detail ?? '', /after assertions_passed/);
  assert.equal(
    result.quality.executed.find(
      (check) => check.id === 'runtime.browser-errors',
    )!.status,
    'errored',
  );
  assert.equal(result.quality.verdict, 'not_evaluated');
});

test('quality lists checks this engine does not perform on every result', () => {
  const quality = evaluateQuality({
    platform: 'web',
    observations: 3,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
  });
  assert.equal(quality.verdict, 'pass');
  assert.deepEqual(
    quality.unsupported.map((gap) => gap.id),
    ['accessibility.audit', 'visual.baseline', 'keyboard.focus'],
  );
  // Model concerns never change the verdict.
  const withHypothesis = evaluateQuality({
    platform: 'web',
    observations: 3,
    findings: [
      {
        kind: 'hypothesis',
        category: 'overflow',
        description: 'Looks cramped',
        step: 0,
        screenshot: 's.png',
      },
    ],
    policyBlocks: 0,
    evidenceComplete: true,
  });
  assert.equal(withHypothesis.verdict, 'pass');
});

test('results whose status contradicts the outcome code are rejected', async () => {
  const { directory } = await run({ successAfter: 1 });
  const [stored] = JSON.parse(
    await readFile(join(directory, 'results.json'), 'utf8'),
  );
  assert.throws(
    () => parseResults(JSON.stringify([{ ...stored, status: 'failed' }])),
    /does not match status/,
  );
  assert.throws(
    () =>
      parseResults(
        JSON.stringify([
          { ...stored, outcome: { ...stored.outcome, source: 'agent' } },
        ]),
      ),
    /must be passed\/assertion/,
  );
});

test('the report names the outcome code and links the deciding screenshot', async () => {
  const { report } = await run({});
  assert.match(report, /Outcome <code>repeated_action<\/code>/);
  assert.match(report, /deciding screenshot/);
  assert.equal(reportHTML('x', [], '/tmp').includes('0/0 runs'), true);
});

test('a declared state that appears between the observation and the success checks is still recorded', async () => {
  // The items render the moment the success check looks (no timing: the
  // check itself flips the page), after the observation's state checks have
  // already seen the loading page. The state must not go unrecorded.
  let loaded = false;
  const base = fakeDriver({ successAfter: 0 });
  const observed: number[] = [];
  const driver: UIDriver = {
    ...base,
    async openSession(options) {
      const session = await base.openSession(options);
      return {
        ...session,
        async observe(step, screenshot) {
          observed.push(step);
          return session.observe(step, screenshot);
        },
        async check(condition) {
          // The success check: the items have appeared.
          if (condition.kind === 'path') {
            loaded = true;
            return true;
          }
          if (condition.kind === 'visible' && condition.target.by === 'testId')
            return loaded;
          return session.check(condition);
        },
      };
    },
  };
  const items = { kind: 'visible', target: { by: 'testId', value: 'items' } };
  const suite = suiteSchema.parse({
    name: 'Late state',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    audits: { checks: [{ id: 'journey.state-checks' }] },
    journeys: [
      {
        id: 'late',
        goal: 'See the items',
        persona: 'Visitor',
        startPath: '/',
        allowedPaths: ['/', '/done'],
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Start' },
        },
        success: [{ kind: 'path', pattern: '^/done$' }],
        states: [{ name: 'loaded', when: items, expect: [items] }],
        maxSteps: 5,
        maxDurationMs: 1000,
      },
    ],
  });
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-late-')), 'run');
  const [result] = await runSuite(
    suite,
    {
      async plan() {
        return { objective: 'Wait', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        return {
          type: 'choice',
          choice: actions[0]!.id,
          confidence: 1,
          probabilities: { [actions[0]!.id]: 1 },
        };
      },
    },
    { directory, driver },
  );
  assert.equal(result!.status, 'passed', result!.reason);
  assert.deepEqual(result!.audits.notReached, []);
  const states = result!.audits.runs.filter(
    (entry) => entry.auditId === 'journey.state-checks',
  );
  assert.deepEqual(
    states.map((entry) => [entry.checkpoint.name, entry.status]),
    [['loaded', 'clean']],
  );
  // One fresh observation of the same step, taken for the pending state.
  assert.deepEqual(observed, [0, 0]);
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event as string);
  assert.equal(
    events.filter((event) => event === 'state_observation').length,
    1,
  );
  // Friction still reconciles with the event log, and the extra observation
  // of the same page is no friction.
  const [logged] = eventLogRuns(
    await readFile(join(directory, 'events.jsonl'), 'utf8'),
  );
  assert.deepEqual(
    computeFriction(logged!, suite.journeys[0]!),
    result!.friction,
  );
  assert.ok(Object.values(result!.friction!.counts).every((count) => !count));
});

test('no extra observation is taken when no declared state is pending', async () => {
  const observed: number[] = [];
  const base = fakeDriver({ successAfter: 0 });
  const driver: UIDriver = {
    ...base,
    async openSession(options) {
      const session = await base.openSession(options);
      return {
        ...session,
        async observe(step, screenshot) {
          observed.push(step);
          return session.observe(step, screenshot);
        },
      };
    },
  };
  const { result } = await run({ successAfter: 0 }, driver);
  assert.equal(result.status, 'passed', result.reason);
  assert.deepEqual(observed, [0]);
});
