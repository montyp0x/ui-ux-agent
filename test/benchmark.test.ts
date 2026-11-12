// The opt-in live-model benchmark harness, verified without any live model:
// model calls go to a local fake OpenAI-compatible server and the UI is an
// in-memory driver. Nothing here is a live model or application measurement.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Action, Observation } from '../src/contracts.js';
import type { UIDriver, UISession } from '../src/drivers/types.js';
import { models, type ModelOptions } from '../src/models.js';
import {
  benchmarkConfigSchema,
  loadBenchmark,
  parseBenchmarkConfig,
  pinnedModelOptions,
} from '../src/benchmark/config.js';
import { BenchmarkBudget } from '../src/benchmark/budget.js';
import {
  aggregateBenchmark,
  failureClass,
  loadBenchmarkReport,
} from '../src/benchmark/aggregate.js';
import { benchmarkMarkdown } from '../src/benchmark/report.js';
import {
  assertLiveOptIn,
  LIVE_OPT_IN_ENV,
  runBenchmark,
} from '../src/benchmark/run.js';
import { distribution, rate, wilson } from '../src/benchmark/stats.js';
import type { Result } from '../src/results.js';

// --- statistics -----------------------------------------------------------

test('wilson interval matches reference values and refuses impossible counts', () => {
  assert.equal(wilson(0, 0), null);
  const one = wilson(1, 1)!;
  assert.ok(Math.abs(one.low - 0.2065) < 1e-3, `low ${one.low}`);
  assert.equal(one.high, 1);
  const eight = wilson(8, 10)!;
  assert.ok(Math.abs(eight.low - 0.4902) < 1e-3, `low ${eight.low}`);
  assert.ok(Math.abs(eight.high - 0.9433) < 1e-3, `high ${eight.high}`);
  const none = wilson(0, 5)!;
  assert.equal(none.low, 0);
  assert.ok(none.high > 0.4 && none.high < 0.45);
  assert.throws(() => wilson(3, 2));
  assert.deepEqual(rate(0, 0), {
    successes: 0,
    n: 0,
    rate: null,
    interval: null,
  });
  // One success is a sample of one, not a 100% pass rate with certainty.
  assert.ok(rate(1, 1).interval!.low < 0.25);
});

test('distribution reports n, median, nearest-rank p90 and max', () => {
  assert.deepEqual(distribution([]), {
    n: 0,
    median: null,
    p90: null,
    max: null,
  });
  assert.deepEqual(distribution([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]), {
    n: 10,
    median: 5.5,
    p90: 9,
    max: 10,
  });
});

// --- configuration --------------------------------------------------------

const ceilings = {
  maxModelCalls: 200,
  maxTokens: 1_000_000,
  maxWallTimeMs: 60_000,
  unknownUsage: 'continue',
};
const reviewed = { by: 'reviewer', on: '2026-11-11' };
function configFor(
  url: string,
  targets: { id: string; suite: string }[],
  overrides: Record<string, unknown> = {},
) {
  return {
    benchmarkVersion: 1,
    name: 'Fixture benchmark',
    targets: targets.map((target) => ({ ...target, reviewed })),
    model: {
      plannerURL: `${url}/planner`,
      plannerModel: 'fake-planner-1',
      selectorProtocol: 'chat',
      selectorURL: `${url}/selector`,
      selectorModel: 'fake-selector-1',
      // Fast pacing for the local fake; live configs pin their own.
      plannerRateLimit: { rpm: 6000, concurrency: 2 },
      selectorRateLimit: { rpm: 6000, concurrency: 4 },
    },
    repeat: 3,
    ceilings,
    ...overrides,
  };
}

test('a benchmark config without every ceiling is refused', () => {
  const base = configFor('http://127.0.0.1:9', [
    { id: 'one', suite: 'suite.json' },
  ]);
  assert.doesNotThrow(() => parseBenchmarkConfig(base));
  for (const missing of [
    'maxModelCalls',
    'maxTokens',
    'maxWallTimeMs',
    'unknownUsage',
  ]) {
    const { [missing as keyof typeof ceilings]: _, ...rest } = ceilings;
    assert.throws(
      () => parseBenchmarkConfig({ ...base, ceilings: rest }),
      new RegExp(`ceilings\\.${missing}`),
      missing,
    );
  }
  assert.throws(
    () => parseBenchmarkConfig({ ...base, ceilings: undefined }),
    /ceilings/,
  );
  // One run is not a pass rate.
  assert.throws(() => parseBenchmarkConfig({ ...base, repeat: 1 }), /repeat/);
  // Keys never go in the config: no query strings or userinfo in endpoints.
  assert.throws(
    () =>
      parseBenchmarkConfig({
        ...base,
        model: { ...base.model, plannerURL: 'https://x.example/v1?key=abc' },
      }),
    /plannerURL/,
  );
  assert.throws(
    () =>
      parseBenchmarkConfig({
        ...base,
        targets: [base.targets[0], base.targets[0]],
      }),
    /unique/,
  );
  assert.throws(
    () =>
      parseBenchmarkConfig({
        ...base,
        targets: [{ id: 'one', suite: 'suite.json' }],
      }),
    /reviewed/,
  );
  assert.ok(benchmarkConfigSchema);
});

test('the example benchmark config is valid and bounded', async () => {
  const loaded = await loadBenchmark('examples/benchmark.json');
  assert.equal(loaded.targets.length, 1);
  assert.ok(loaded.config.ceilings.maxModelCalls <= 200);
  assert.equal(loaded.config.ceilings.unknownUsage, 'stop');
});

test('the pinned model configuration overrides the environment and keeps keys out', () => {
  const config = parseBenchmarkConfig(
    configFor('http://127.0.0.1:9', [{ id: 'one', suite: 'suite.json' }]),
  );
  const { options, overridden } = pinnedModelOptions(config.model, {
    PLANNER_API_KEY: 'secret-planner-key',
    PLANNER_MODEL: 'something-else',
  });
  assert.equal(options.plannerModel, 'fake-planner-1');
  assert.equal(options.selectorModel, 'fake-selector-1');
  assert.equal(options.selectorProtocol, 'chat');
  assert.equal(options.plannerKey, 'secret-planner-key');
  assert.deepEqual(overridden, ['PLANNER_MODEL']);
  assert.throws(() => pinnedModelOptions(config.model, {}), /PLANNER_API_KEY/);
});

// --- opt-in ---------------------------------------------------------------

test('a live benchmark needs both the --live flag and the opt-in variable, and never runs under node --test', () => {
  assert.throws(
    () => assertLiveOptIn({ flag: false, env: { [LIVE_OPT_IN_ENV]: '1' } }),
    /--live/,
  );
  assert.throws(
    () => assertLiveOptIn({ flag: true, env: {} }),
    new RegExp(LIVE_OPT_IN_ENV),
  );
  assert.throws(
    () => assertLiveOptIn({ flag: true, env: { [LIVE_OPT_IN_ENV]: 'yes' } }),
    new RegExp(LIVE_OPT_IN_ENV),
  );
  assert.throws(
    () =>
      assertLiveOptIn({
        flag: true,
        env: { [LIVE_OPT_IN_ENV]: '1', NODE_TEST_CONTEXT: 'child-v8' },
      }),
    /test runner/,
  );
  assert.doesNotThrow(() =>
    assertLiveOptIn({ flag: true, env: { [LIVE_OPT_IN_ENV]: '1' } }),
  );
});

// --- fakes ----------------------------------------------------------------

type FakeModelOptions = {
  // Omit the usage block for these roles.
  missingUsage?: ('planner' | 'selector')[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  delayMs?: number;
  concerns?: { symptom: string; userImpact: string }[];
};
type FakeModel = {
  url: string;
  requests: { planner: number; selector: number };
  server: Server;
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function fakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
  const requests = { planner: 0, selector: 0 };
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const role = request.url === '/planner' ? 'planner' : 'selector';
    requests[role]++;
    if (options.delayMs)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const body = JSON.parse(text) as {
      messages: { content: unknown }[];
      response_format?: {
        json_schema: {
          schema: { properties: { choice?: { enum: string[] } } };
        };
      };
    };
    let content: string;
    if (role === 'planner')
      content = JSON.stringify({
        objective: 'Continue',
        concerns: options.concerns ?? [],
      });
    else {
      const ids =
        body.response_format!.json_schema.schema.properties.choice!.enum;
      const { state } = JSON.parse(String(body.messages[1]!.content)) as {
        state: { goal: string };
      };
      const choice = state.goal.includes('[no-match]')
        ? 'no_match'
        : ids.find((id) => id !== 'no_match')!;
      content = JSON.stringify({
        choice,
        probabilities: Object.fromEntries(
          ids.map((id) => [id, id === choice ? 1 : 0]),
        ),
      });
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        ...(options.missingUsage?.includes(role)
          ? {}
          : {
              usage: options.usage ?? {
                prompt_tokens: 100,
                completion_tokens: 10,
              },
            }),
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, requests, server };
}

type Scenario = {
  // Executed actions after which the success assertion holds.
  successAfter?: number;
  // The page state changes after each action (no loop).
  changes?: boolean;
  outOfScope?: boolean;
  unauthorized?: boolean;
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
      const done = () => executed >= (scenario.successAfter ?? Infinity);
      return {
        browserErrors: [],
        policyBlocks: [],
        get unauthorized() {
          return !!scenario.unauthorized && observed > 0;
        },
        async start() {},
        setTimeout() {},
        location: () => 'https://app.example/',
        async check(condition) {
          if (condition.kind === 'visible') return true;
          return done();
        },
        async observe(step, screenshot): Promise<Observation> {
          observed++;
          // The planner adapter reads the observation's screenshot file.
          await writeFile(screenshot, 'fixture-screenshot');
          return {
            step,
            url: done() ? 'https://app.example/done' : 'https://app.example/',
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
            horizontalOverflow: 0,
          };
        },
        async candidates() {
          return [{ ...continueAction }];
        },
        async execute() {
          executed++;
        },
        async screenshot(path) {
          await writeFile(path, 'fixture-screenshot');
        },
        async inScope() {
          return !scenario.outOfScope;
        },
        async finish() {
          return { video: null, trace: null };
        },
      };
    },
    async close() {},
  };
}

function suiteFile(goal = 'Finish the fixture task') {
  return {
    name: 'Benchmark fixture suite',
    baseURL: 'https://app.example',
    requiresAuth: false,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [
      {
        id: 'finish',
        goal,
        persona: 'Visitor',
        startPath: '/',
        allowedPaths: ['/', '/done'],
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
        maxSteps: 12,
        maxDurationMs: 20000,
      },
    ],
  };
}

type TargetSpec = {
  id: string;
  scenario: Scenario;
  goal?: string;
  // Merged over the fixture suite.
  suite?: Record<string, unknown>;
};

async function setup(
  fake: FakeModel,
  targets: TargetSpec[],
  overrides: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ui-ux-benchmark-'));
  for (const target of targets)
    await writeFile(
      join(root, `${target.id}.json`),
      JSON.stringify({ ...suiteFile(target.goal), ...target.suite }),
    );
  const configPath = join(root, 'benchmark.json');
  await writeFile(
    configPath,
    JSON.stringify(
      configFor(
        fake.url,
        targets.map((target) => ({
          id: target.id,
          suite: `${target.id}.json`,
        })),
        overrides,
      ),
    ),
  );
  const loaded = await loadBenchmark(configPath);
  const scenarios = new Map(
    targets.map((target) => [target.id, target.scenario]),
  );
  const modelOptions: ModelOptions = pinnedModelOptions(loaded.config.model, {
    PLANNER_API_KEY: 'fixture-key',
  }).options;
  return {
    root,
    loaded,
    modelOptions,
    run: (extra: Partial<Parameters<typeof runBenchmark>[1]> = {}) =>
      runBenchmark(loaded, {
        mode: 'fixture',
        modelOptions,
        directory: join(root, 'out'),
        driver: (target) => fakeDriver(scenarios.get(target.id)!),
        ...extra,
      }),
  };
}

const success: Scenario = { successAfter: 2, changes: true };

// --- runs -----------------------------------------------------------------

test('a fixture benchmark aggregates completion with n and interval, calls, tokens and latency', async () => {
  const fake = await fakeModel();
  const { run, root } = await setup(fake, [
    { id: 'passes', scenario: success },
    { id: 'no-path', scenario: { changes: true }, goal: 'Finish [no-match]' },
  ]);
  const { report, record } = await run();
  assert.equal(record.mode, 'fixture');
  assert.equal(record.stop, null);
  assert.equal(report.overall.planned, 6);
  assert.equal(report.overall.evaluated, 6);
  assert.equal(report.overall.completion.successes, 3);
  assert.equal(report.overall.completion.n, 6);
  assert.ok(report.overall.completion.interval!.low > 0.1);
  assert.ok(report.overall.completion.interval!.high < 0.9);
  const passes = report.targets.find((target) => target.id === 'passes')!;
  assert.equal(passes.completion.successes, 3);
  assert.equal(passes.completion.n, 3);
  const noPath = report.targets.find((target) => target.id === 'no-path')!;
  assert.equal(noPath.completion.successes, 0);
  assert.equal(noPath.failures.agent, 3);
  // Every request the fake server answered is counted, and reconciles with
  // the per-run usage the runner recorded.
  const served = fake.requests.planner + fake.requests.selector;
  assert.equal(report.overall.calls.dispatched, served);
  assert.equal(report.overall.calls.completed, served);
  assert.equal(
    report.overall.calls.byRole.planner.dispatched,
    fake.requests.planner,
  );
  assert.equal(report.harness.usageReconciled, true);
  assert.equal(report.harness.dispatchWithinCeiling, true);
  assert.equal(report.overall.tokens.input, served * 100);
  assert.equal(report.overall.tokens.output, served * 10);
  assert.equal(report.overall.tokens.unknownCalls, 0);
  assert.equal(report.overall.latency.planner.n, fake.requests.planner);
  assert.equal(report.overall.latency.selector.n, fake.requests.selector);
  // Precision without reviewer labels is unknown, never assumed.
  assert.equal(report.precision.status, 'unknown');
  // Written next to the target run directories.
  const stored = JSON.parse(
    await readFile(join(root, 'out', 'benchmark-report.json'), 'utf8'),
  );
  assert.deepEqual(stored, JSON.parse(JSON.stringify(report)));
  const markdown = await readFile(
    join(root, 'out', 'benchmark-report.md'),
    'utf8',
  );
  assert.match(markdown, /not a live model measurement/i);
  assert.match(markdown, /n = 6/);
  assert.match(markdown, /95% Wilson/);
  assert.match(markdown, /## Model quality/);
  assert.match(markdown, /## Harness correctness/);
  assert.match(markdown, /fake-planner-1/);
  assert.match(markdown, /passes/);
  assert.match(markdown, /release thresholds/i);
});

test('benchmark output holds no credentials or suite-declared secrets', async () => {
  const fake = await fakeModel();
  const key = 'sk-fixture-planted-credential-0123456789';
  const { run, root } = await setup(fake, [
    {
      id: 'passes',
      scenario: success,
      suite: {
        name: 'Suite SECRET-SUITE-4f2a9c',
        evidence: { redact: [{ pattern: 'SECRET-SUITE-\\w+' }] },
      },
    },
  ]);
  const { modelOptions } = await setup(fake, [
    { id: 'other', scenario: success },
  ]);
  await run({
    modelOptions: { ...modelOptions, plannerKey: key, selectorKey: key },
    env: { PLANNER_API_KEY: key },
  });
  for (const file of [
    'benchmark.json',
    'benchmark-report.json',
    'benchmark-report.md',
  ]) {
    const text = await readFile(join(root, 'out', file), 'utf8');
    assert.doesNotMatch(text, /SECRET-SUITE-4f2a9c/, file);
    assert.ok(!text.includes(key), file);
  }
});

test('the model-call ceiling stops before any request past it is sent', async () => {
  const fake = await fakeModel();
  const { run } = await setup(fake, [{ id: 'passes', scenario: success }], {
    ceilings: { ...ceilings, maxModelCalls: 5 },
  });
  const { report, record } = await run();
  assert.equal(fake.requests.planner + fake.requests.selector, 5);
  assert.equal(record.stop?.reason, 'max_model_calls');
  assert.equal(report.overall.calls.dispatched, 5);
  assert.equal(report.harness.dispatchWithinCeiling, true);
  // The run cut off by the ceiling is interrupted, not a failure, and the
  // runs that never started are listed, not counted.
  assert.equal(report.overall.interrupted, 1);
  assert.equal(report.overall.evaluated + 1 + report.overall.notStarted, 3);
  assert.equal(report.overall.completion.n, report.overall.evaluated);
  assert.match(benchmarkMarkdown(report), /max_model_calls/);
});

test('the token ceiling stops once reported tokens reach it', async () => {
  const fake = await fakeModel({
    usage: { prompt_tokens: 80, completion_tokens: 20 },
  });
  const { run } = await setup(fake, [{ id: 'passes', scenario: success }], {
    ceilings: { ...ceilings, maxTokens: 250 },
  });
  const { report, record } = await run();
  assert.equal(record.stop?.reason, 'max_tokens');
  assert.equal(fake.requests.planner + fake.requests.selector, 3);
  assert.equal(report.overall.tokens.input, 240);
  assert.equal(report.overall.tokens.output, 60);
});

test('the wall-time ceiling stops the benchmark and records it', async () => {
  const fake = await fakeModel({ delayMs: 150 });
  const { run } = await setup(fake, [{ id: 'passes', scenario: success }], {
    ceilings: { ...ceilings, maxWallTimeMs: 1000 },
    repeat: 10,
  });
  const started = Date.now();
  const { report, record } = await run();
  assert.equal(record.stop?.reason, 'max_wall_time');
  assert.ok(Date.now() - started < 5000);
  assert.ok(report.overall.notStarted > 0);
});

test('missing provider usage is unknown, never zero, and can stop the token ceiling', async () => {
  const fake = await fakeModel({ missingUsage: ['selector'] });
  const continued = await setup(fake, [{ id: 'passes', scenario: success }]);
  const { report } = await continued.run();
  assert.equal(report.overall.tokens.input, 'unknown');
  assert.equal(report.overall.tokens.output, 'unknown');
  assert.equal(report.overall.tokens.unknownCalls, fake.requests.selector);
  assert.equal(
    report.overall.tokens.lowerBound.input,
    fake.requests.planner * 100,
  );
  assert.equal(
    report.overall.calls.byRole.selector.usageUnknown,
    fake.requests.selector,
  );
  assert.match(benchmarkMarkdown(report), /unknown/);

  const strict = await fakeModel({ missingUsage: ['selector'] });
  const stopped = await setup(strict, [{ id: 'passes', scenario: success }], {
    ceilings: { ...ceilings, unknownUsage: 'stop' },
  });
  const { record } = await stopped.run();
  assert.equal(record.stop?.reason, 'token_usage_unknown');
  assert.equal(strict.requests.selector, 1);
});

test('failure classes separate agent, policy and environment failures and count loops', async () => {
  const fake = await fakeModel();
  const { run } = await setup(fake, [
    { id: 'loop', scenario: {} },
    { id: 'scope', scenario: { outOfScope: true } },
    { id: 'auth', scenario: { unauthorized: true } },
  ]);
  const { report } = await run();
  const byId = Object.fromEntries(report.targets.map((t) => [t.id, t]));
  assert.equal(byId.loop!.failures.agent, 3);
  assert.equal(byId.loop!.loops.runsEndedByLoop, 3);
  assert.ok(byId.loop!.loops.rejected >= 3);
  assert.ok(byId.loop!.loops.replans >= 3);
  assert.equal(byId.scope!.failures.policy, 3);
  assert.equal(byId.auth!.failures.environment, 3);
  // Harness and environment failures are not model failures.
  assert.equal(report.overall.modelCompletion.n, 3);
  assert.equal(report.overall.completion.n, 9);
  assert.equal(report.harness.failures.policy, 3);
  assert.equal(report.harness.failures.environment, 3);
  assert.equal(report.modelQuality.failures.agent, 3);
});

test('failureClass follows the result contract categories', () => {
  const outcome = (code: string, category: string, source: string) =>
    ({ outcome: { code, category, source } }) as unknown as Result;
  assert.equal(
    failureClass(outcome('assertions_passed', 'passed', 'assertion')),
    'passed',
  );
  assert.equal(
    failureClass(outcome('run_cancelled', 'cancelled', 'harness')),
    'interrupted',
  );
  assert.equal(
    failureClass(outcome('repeated_action', 'agent_loop', 'agent')),
    'agent',
  );
  assert.equal(
    failureClass(outcome('model_invalid_output', 'model_error', 'model')),
    'model',
  );
  assert.equal(
    failureClass(outcome('scope_exit', 'policy_block', 'harness')),
    'policy',
  );
  assert.equal(
    failureClass(
      outcome('data_setup_failed', 'precondition_failure', 'environment'),
    ),
    'environment',
  );
  assert.equal(
    failureClass(outcome('budget_max_steps', 'budget_exhausted', 'unknown')),
    'budget',
  );
  assert.equal(
    failureClass(outcome('driver_error', 'infrastructure_error', 'unknown')),
    'harness',
  );
});

test('reviewer labels give finding precision with n; unknown references are refused', async () => {
  const fake = await fakeModel({
    concerns: [{ symptom: 'Button label is vague', userImpact: 'Hesitation' }],
  });
  const { run, root } = await setup(fake, [
    { id: 'passes', scenario: success },
  ]);
  const { report } = await run();
  assert.equal(report.precision.status, 'unknown');
  assert.ok(report.precision.findings.hypothesis >= 3);
  const out = join(root, 'out');
  const key = (attempt: number) => ({
    target: 'passes',
    journey: 'finish',
    viewport: 'desktop',
    attempt,
    source: 'finding',
    index: 0,
  });
  const labels = join(root, 'labels.json');
  await writeFile(
    labels,
    JSON.stringify({
      labelsVersion: 1,
      reviewer: 'reviewer',
      labels: [
        { ...key(1), verdict: 'confirmed' },
        { ...key(2), verdict: 'confirmed' },
        { ...key(3), verdict: 'rejected' },
      ],
    }),
  );
  const labelled = await loadBenchmarkReport(out, labels);
  assert.equal(labelled.precision.status, 'measured');
  const hypothesis = labelled.precision.byKind.hypothesis!;
  assert.equal(hypothesis.precision.successes, 2);
  assert.equal(hypothesis.precision.n, 3);
  assert.ok(hypothesis.precision.interval);
  assert.equal(hypothesis.unlabelled, hypothesis.total - 3);
  await writeFile(
    labels,
    JSON.stringify({
      labelsVersion: 1,
      reviewer: 'reviewer',
      labels: [{ ...key(1), index: 7, verdict: 'confirmed' }],
    }),
  );
  await assert.rejects(loadBenchmarkReport(out, labels), /no finding/);
  // Re-aggregation from disk matches the run's own report.
  const again = await loadBenchmarkReport(out);
  assert.deepEqual(
    JSON.parse(JSON.stringify(again)),
    JSON.parse(JSON.stringify(report)),
  );
  assert.ok(aggregateBenchmark);
});

test('a live benchmark is refused under the test runner before any request', async () => {
  const fake = await fakeModel();
  const { loaded, modelOptions, root } = await setup(fake, [
    { id: 'passes', scenario: success },
  ]);
  await assert.rejects(
    runBenchmark(loaded, {
      mode: 'live',
      optIn: { flag: true, env: { [LIVE_OPT_IN_ENV]: '1' } },
      modelOptions,
      directory: join(root, 'live'),
      driver: () => fakeDriver(success),
    }),
    /test runner/,
  );
  assert.equal(fake.requests.planner + fake.requests.selector, 0);
});

test('a fixture benchmark only talks to loopback model endpoints', async () => {
  const fake = await fakeModel();
  const { loaded, modelOptions, root } = await setup(fake, [
    { id: 'passes', scenario: success },
  ]);
  await assert.rejects(
    runBenchmark(loaded, {
      mode: 'fixture',
      modelOptions: { ...modelOptions, selectorURL: 'https://api.example/v1' },
      directory: join(root, 'remote'),
      driver: () => fakeDriver(success),
    }),
    /loopback|pinned/,
  );
});

test('a suite whose pinned sha256 does not match is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-ux-benchmark-sha-'));
  const text = JSON.stringify(suiteFile());
  await writeFile(join(root, 'one.json'), text);
  const config = configFor('http://127.0.0.1:9', [
    { id: 'one', suite: 'one.json' },
  ]);
  const good = createHash('sha256').update(text).digest('hex');
  await writeFile(
    join(root, 'ok.json'),
    JSON.stringify({
      ...config,
      targets: [{ ...config.targets[0], sha256: good }],
    }),
  );
  const loaded = await loadBenchmark(join(root, 'ok.json'));
  assert.equal(loaded.targets[0]!.sha256, good);
  await writeFile(
    join(root, 'bad.json'),
    JSON.stringify({
      ...config,
      targets: [{ ...config.targets[0], sha256: '0'.repeat(64) }],
    }),
  );
  await assert.rejects(loadBenchmark(join(root, 'bad.json')), /sha256/);
});

test('the budget refuses dispatch in the model adapter: a refused request never reaches the server', async () => {
  const fake = await fakeModel();
  const budget = new BenchmarkBudget({
    maxModelCalls: 1,
    maxTokens: 1000,
    maxWallTimeMs: 60_000,
    unknownUsage: 'continue',
  });
  const adapter = models({
    plannerURL: `${fake.url}/planner`,
    plannerKey: 'k',
    plannerModel: 'fake-planner-1',
    selectorProtocol: 'chat',
    selectorURL: `${fake.url}/selector`,
    selectorKey: 'k',
    selectorModel: 'fake-selector-1',
    plannerRateLimit: { rpm: 6000, concurrency: 2 },
    beforeDispatch: (data) => budget.beforeDispatch(data),
    onCall: async (data) => void budget.recordCall(data),
  });
  const observation = {
    step: 0,
    url: 'https://app.example/',
    snapshot: '',
    screenshot: '',
    visibleViewport: {
      width: 1,
      height: 1,
      text: '',
      textTruncated: false,
      controls: [],
      canScrollUp: false,
      canScrollDown: false,
      scrollRegions: [],
    },
    fingerprint: 'x',
    scroll: { x: 0, y: 0, containers: [] },
    horizontalOverflow: 0,
  } as Observation;
  const journey = suiteFile().journeys[0] as never;
  await adapter.plan(journey, observation, [], 5000);
  await assert.rejects(
    adapter.plan(journey, observation, [], 5000),
    (error: Error) => error.name === 'AbortError',
  );
  assert.equal(fake.requests.planner, 1);
  assert.equal(budget.stop?.reason, 'max_model_calls');
  budget.dispose();
});

test('the benchmark CLI refuses a live run without the opt-in variable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-ux-benchmark-cli-'));
  const { [LIVE_OPT_IN_ENV]: _, NODE_TEST_CONTEXT: __, ...env } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/benchmark/cli.ts',
      '--config',
      join(root, 'missing.json'),
      '--live',
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, new RegExp(LIVE_OPT_IN_ENV));
  const noFlag = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/benchmark/cli.ts',
      '--config',
      join(root, 'x.json'),
    ],
    { env: { ...env, [LIVE_OPT_IN_ENV]: '1' }, encoding: 'utf8' },
  );
  assert.equal(noFlag.status, 2, noFlag.stderr);
  assert.match(noFlag.stderr, /--live/);
});
