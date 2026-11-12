// Declared state expectations (journey.state-checks): configuration, the
// audit's runs at each state's checkpoint and the quality verdict, against an
// in-memory session. No model calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditsResultSchema } from '../src/audits/contract.js';
import { JourneyAudits } from '../src/audits/run.js';
import {
  suiteSchema,
  type Check,
  type Observation,
  type Suite,
} from '../src/contracts.js';
import type { UISession } from '../src/drivers/types.js';
import { evaluateQuality } from '../src/quality.js';

const visible = (value: string): Check => ({
  kind: 'visible',
  target: { by: 'testId', value },
});
const journey = {
  id: 'states',
  goal: 'Load the list',
  persona: 'A visitor',
  startPath: '/',
  allowedPaths: ['/'],
  ready: visible('home'),
  success: [{ kind: 'path', pattern: '^/done$' }],
  states: [
    {
      name: 'error',
      when: visible('error'),
      expect: [visible('retry'), visible('error-message')],
    },
    { name: 'empty', when: visible('empty'), expect: [visible('create')] },
    { name: 'plain', when: visible('plain') },
  ],
};
const suite = (extra: Record<string, unknown> = {}): Suite =>
  suiteSchema.parse({
    name: 'state checks',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [journey],
    audits: { checks: [{ id: 'journey.state-checks' }] },
    ...extra,
  }) as Suite;

const state = (step: number): Observation => ({
  step,
  url: `https://app.example/?step=${step}`,
  snapshot: '',
  screenshot: `step-${step}.png`,
  visibleViewport: {
    width: 800,
    height: 600,
    text: '',
    textTruncated: false,
    controls: [],
    canScrollUp: false,
    canScrollDown: false,
    scrollRegions: [],
  },
  fingerprint: `f${step}`,
  scroll: { x: 0, y: 0, containers: [] },
  horizontalOverflow: 0,
});

function session(holds: (condition: Check) => boolean): UISession {
  return {
    browserErrors: [],
    unauthorized: false,
    async start() {},
    setTimeout() {},
    location: () => 'https://app.example/final',
    async check(condition) {
      return holds(condition);
    },
    async observe() {
      throw new Error('not used');
    },
    async candidates() {
      return [];
    },
    async execute() {},
    async screenshot() {},
    async finish() {
      return { video: null };
    },
  };
}

// The test ids visible at each step.
async function run(configured: Suite, visibleAt: string[][]) {
  let step = 0;
  const runner = new JourneyAudits({
    suite: configured,
    journey: configured.journeys[0]!,
    viewport: { name: 'desktop', width: 800, height: 600 },
    directory: '/tmp/run',
    session: session((condition) => {
      if (!('target' in condition) || condition.target.by !== 'testId')
        return false;
      if (condition.target.value === 'explode')
        throw new Error('locator exploded');
      return visibleAt[step]!.includes(condition.target.value);
    }),
    log: async () => {},
  });
  for (; step < visibleAt.length; step++) {
    runner.record(state(step));
    await runner.afterObservation(state(step));
  }
  return auditsResultSchema.parse(runner.finish());
}

test('state expect checks need the journey.state-checks audit and are validated at load', () => {
  const base = {
    name: 'state checks',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
  };
  assert.throws(
    () =>
      suiteSchema.parse({
        ...base,
        journeys: [journey],
        audits: { checks: [{ id: 'layout.horizontal-overflow', at: ['states'] }] },
      }),
    /add the journey.state-checks audit/,
  );
  // Expectations are checks: same shapes, same regex validation.
  assert.throws(
    () =>
      suite({
        journeys: [
          {
            ...journey,
            states: [
              {
                name: 'bad',
                when: visible('x'),
                expect: [{ kind: 'path', pattern: '(' }],
              },
            ],
          },
        ],
      }),
    /Invalid regex/,
  );
  // The audit only runs at declared states.
  assert.throws(
    () =>
      suite({
        audits: { checks: [{ id: 'journey.state-checks', at: ['completion'] }] },
      }),
    /states/,
  );
  assert.throws(
    () => suite({ journeys: [{ ...journey, states: [{ ...journey.states[0], expect: [] }] }] }),
    /expect/,
  );
  const parsed = suite();
  assert.deepEqual(parsed.audits.checks, [
    { id: 'journey.state-checks', at: ['states'], severity: 'serious' },
  ]);
});

test('each declared state is checked on its own expectations, once, when it first holds', async () => {
  const result = await run(suite(), [
    ['home'],
    // Error state without its retry control.
    ['error', 'error-message'],
    // Seen again later with the retry: not re-evaluated.
    ['error', 'error-message', 'retry'],
    ['empty', 'create'],
    ['plain'],
  ]);
  assert.deepEqual(
    result.runs.map((entry) => [
      entry.checkpoint.id,
      entry.checkpoint.step,
      entry.status,
    ]),
    [
      ['state:error', 1, 'findings'],
      ['state:empty', 3, 'clean'],
      ['state:plain', 4, 'clean'],
    ],
  );
  assert.equal(result.findings.length, 1);
  const [missing] = result.findings;
  assert.equal(missing!.ruleId, 'state-expectation');
  assert.equal(missing!.certainty, 'violation');
  assert.equal(missing!.severity, 'serious');
  assert.equal(missing!.gating, true);
  assert.match(missing!.description, /state error.*check 1.*visible test id "retry"/);
  assert.deepEqual(missing!.tags, ['state:error', 'check:visible']);
  assert.equal(missing!.evidence.screenshot, 'step-1.png');
  assert.deepEqual(result.runs[2]!.limitations, [
    'State plain declares no expect checks',
  ]);
  const quality = evaluateQuality({
    platform: 'web',
    observations: 5,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
    audits: result,
  });
  assert.equal(quality.verdict, 'fail');
  assert.match(quality.reason, /journey.state-checks/);
});

test('a state that is never reached is not reached, never clean, and keeps quality from passing', async () => {
  const result = await run(suite(), [['home'], ['empty', 'create']]);
  assert.deepEqual(
    result.notReached.map((gap) => gap.at),
    ['state:error', 'state:plain'],
  );
  assert.deepEqual(
    result.runs.map((entry) => entry.status),
    ['clean'],
  );
  const quality = evaluateQuality({
    platform: 'web',
    observations: 2,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
    audits: result,
  });
  assert.notEqual(quality.verdict, 'fail');
  assert.equal(
    quality.executed.find((check) => check.id === 'journey.state-checks')
      ?.status,
    'passed',
  );
});

test('an expectation that cannot be evaluated makes the run incomplete, not clean', async () => {
  const configured = suite({
    journeys: [
      {
        ...journey,
        states: [
          {
            name: 'error',
            when: visible('error'),
            expect: [visible('explode'), visible('retry')],
          },
        ],
      },
    ],
    audits: {
      checks: [{ id: 'journey.state-checks', severity: 'moderate' }],
    },
  });
  const result = await run(configured, [['home'], ['error']]);
  assert.equal(result.runs[0]!.status, 'incomplete');
  assert.match(result.runs[0]!.detail ?? '', /expect\[0\].*locator exploded/);
  // The decidable expectation is still reported, under the configured severity.
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.severity, 'moderate');
  assert.equal(result.findings[0]!.gating, false);
  const quality = evaluateQuality({
    platform: 'web',
    observations: 2,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
    audits: result,
  });
  assert.equal(quality.verdict, 'not_evaluated');
});
