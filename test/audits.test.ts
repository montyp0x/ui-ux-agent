// Checkpoint audits: configuration, checkpoint timing, run statuses, the
// quality verdict and the report, against in-memory sessions and a real
// Chromium page. No model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AuditConfig, AuditId } from '../src/audits/config.js';
import {
  auditOutputSchema,
  auditsResultSchema,
  isGating,
  type AuditOutput,
  type DriverKind,
} from '../src/audits/contract.js';
import { AUDITS, type AuditDefinition } from '../src/audits/registry.js';
import { JourneyAudits } from '../src/audits/run.js';
import {
  suiteSchema,
  type Action,
  type Check,
  type Observation,
  type Suite,
} from '../src/contracts.js';
import type { DriverAuditRequest, UISession } from '../src/drivers/types.js';
import type { Models } from '../src/models.js';
import { evaluateQuality } from '../src/quality.js';
import { reportHTML } from '../src/report.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';

const journey = {
  id: 'find',
  goal: 'Find the result',
  persona: 'A visitor',
  startPath: '/',
  allowedPaths: ['/'],
  ready: {
    kind: 'visible',
    target: { by: 'role', role: 'heading', name: 'Home' },
  },
  success: [{ kind: 'path', pattern: '^/done$' }],
};
const suiteWith = (extra: Record<string, unknown> = {}, journeyExtra = {}) =>
  suiteSchema.parse({
    name: 'audits',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [{ ...journey, ...journeyExtra }],
    ...extra,
  }) as Suite;

const state = (step: number, overflow = 0): Observation => ({
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
  horizontalOverflow: overflow,
});

// A session for JourneyAudits alone: only check, location and runAudit matter.
function session(
  options: {
    driver?: DriverKind;
    holds?: (condition: Check) => boolean;
    runAudit?: (request: DriverAuditRequest) => Promise<unknown>;
  } = {},
): UISession {
  return {
    driver: options.driver,
    browserErrors: [],
    unauthorized: false,
    async start() {},
    setTimeout() {},
    location: () => 'https://app.example/final',
    async check(condition) {
      return options.holds?.(condition) ?? false;
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
    ...(options.runAudit ? { runAudit: options.runAudit } : {}),
  };
}

const TEST_AUDIT = 'test.driver-audit' as AuditId;
const driverAudit: AuditDefinition = {
  id: TEST_AUDIT,
  source: 'test-analyzer',
  title: 'Driver audit under test',
  drivers: ['playwright'],
  unsupported: 'Not available on this driver',
};
const definitions = (id: AuditId) =>
  id === TEST_AUDIT ? driverAudit : (AUDITS[id] as AuditDefinition);

function audits(
  suite: Suite,
  sessionOptions: Parameters<typeof session>[0] = {},
  checks?: AuditConfig[],
) {
  const events: { event: string; data: unknown }[] = [];
  if (checks) suite.audits.checks = checks;
  const runner = new JourneyAudits({
    suite,
    journey: suite.journeys[0]!,
    viewport: { name: 'desktop', width: 800, height: 600 },
    directory: '/tmp/run',
    session: session(sessionOptions),
    log: async (event, data) => {
      events.push({ event, data });
    },
    definitions,
  });
  return { runner, events };
}
const testCheck = (at: AuditConfig['at']): AuditConfig =>
  ({ id: TEST_AUDIT, at }) as unknown as AuditConfig;

async function driven(output: AuditOutput | (() => Promise<unknown>)) {
  const { runner } = audits(
    suiteWith(),
    {
      runAudit: typeof output === 'function' ? output : async () => output,
    },
    [testCheck(['completion'])],
  );
  runner.record(state(0));
  await runner.afterObservation(state(0));
  await runner.completion(1, 'final.png');
  return runner.finish();
}

const finding = (
  overrides: Partial<AuditOutput['findings'][number]> = {},
): AuditOutput['findings'][number] => ({
  ruleId: 'button-name',
  severity: 'critical',
  certainty: 'violation',
  description: 'Buttons must have discernible text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/button-name',
  tags: ['wcag2a', 'wcag412'],
  nodeCount: 3,
  targets: [
    { description: 'button', selector: '#save', snippet: '<button id="save">' },
  ],
  ...overrides,
});

test('suites get the overflow audit at completion and fail on serious by default', () => {
  const suite = suiteWith();
  assert.deepEqual(suite.audits, {
    checks: [{ id: 'layout.horizontal-overflow', at: ['completion'] }],
    failOn: 'serious',
    timeoutMs: 15000,
  });
  assert.deepEqual(
    suiteWith({ audits: { checks: [] } }).audits.checks,
    [],
    'audits can be turned off explicitly',
  );
});

test('audit configuration is validated at the boundary', () => {
  const invalid: [Record<string, unknown>, object, RegExp][] = [
    [{ audits: { checks: [{ id: 'unknown.audit' }] } }, {}, /id/],
    [
      {
        audits: {
          checks: [
            { id: 'layout.horizontal-overflow' },
            { id: 'layout.horizontal-overflow' },
          ],
        },
      },
      {},
      /configured once/,
    ],
    [
      {
        audits: {
          checks: [
            { id: 'layout.horizontal-overflow', at: ['ready', 'ready'] },
          ],
        },
      },
      {},
      /unique/,
    ],
    [{ audits: { failOn: 'severe' } }, {}, /failOn/],
    [
      {
        audits: {
          checks: [{ id: 'layout.horizontal-overflow', timeoutMs: 500 }],
        },
      },
      {},
      /timeoutMs/,
    ],
    // A declared state with no audit at 'states' would never run anything.
    [
      {},
      {
        states: [{ name: 'done', when: { kind: 'path', pattern: '^/done$' } }],
      },
      /no audit runs at 'states'/,
    ],
    [
      {
        audits: {
          checks: [{ id: 'layout.horizontal-overflow', at: ['states'] }],
        },
      },
      {
        states: [
          { name: 'done', when: { kind: 'path', pattern: '^/done$' } },
          { name: 'done', when: { kind: 'path', pattern: '^/x$' } },
        ],
      },
      /State names must be unique/,
    ],
    [
      {
        audits: {
          checks: [{ id: 'layout.horizontal-overflow', at: ['states'] }],
        },
      },
      { states: [{ name: 'done', when: { kind: 'path', pattern: '(' } }] },
      /Invalid regex/,
    ],
  ];
  for (const [extra, journeyExtra, message] of invalid)
    assert.throws(() => suiteWith(extra, journeyExtra), message);
});

test('configured checkpoints run each audit once, at ready, declared states and completion', async () => {
  const suite = suiteWith(
    {
      audits: {
        checks: [
          {
            id: 'layout.horizontal-overflow',
            at: ['ready', 'states', 'completion'],
          },
        ],
      },
    },
    {
      states: [
        { name: 'done', when: { kind: 'path', pattern: '^/done$' } },
        { name: 'never', when: { kind: 'path', pattern: '^/never$' } },
      ],
    },
  );
  let step = 0;
  const { runner, events } = audits(suite, {
    holds: (condition) =>
      condition.kind === 'path' && condition.pattern === '^/done$' && step >= 2,
  });
  for (; step < 4; step++) {
    runner.record(state(step, step === 1 ? 30 : 0));
    await runner.afterObservation(state(step));
  }
  await runner.completion(4, 'final.png');
  await runner.completion(4, 'final.png');
  const result = auditsResultSchema.parse(runner.finish());
  assert.deepEqual(
    result.runs.map((run) => [
      run.checkpoint.id,
      run.checkpoint.step,
      run.status,
    ]),
    [
      ['ready', 0, 'clean'],
      ['state:done', 2, 'findings'],
      ['completion', 4, 'clean'],
    ],
  );
  // Each run reads the states observed since the previous one.
  assert.deepEqual(
    result.runs.map((run) => run.observations),
    [1, 2, 1],
  );
  assert.equal(result.runs[2]!.checkpoint.url, 'https://app.example/final');
  assert.equal(result.runs[2]!.checkpoint.screenshot, 'final.png');
  assert.deepEqual(result.notReached, [
    { auditId: 'layout.horizontal-overflow', at: 'state:never' },
  ]);
  const [overflow] = result.findings;
  assert.equal(overflow!.reproduction.checkpoint, 'state:done');
  assert.equal(overflow!.reproduction.step, 1);
  assert.equal(overflow!.evidence.screenshot, 'step-1.png');
  assert.equal(events.filter((entry) => entry.event === 'audit_run').length, 3);
});

test('an unsupported audit is reported per checkpoint and never run', async () => {
  let called = 0;
  const { runner } = audits(
    suiteWith(),
    {
      driver: 'macos',
      runAudit: async () => {
        called++;
        return { complete: true, findings: [] };
      },
    },
    [testCheck(['ready', 'completion'])],
  );
  runner.record(state(0));
  await runner.afterObservation(state(0));
  await runner.completion(0, 'final.png');
  const result = runner.finish();
  assert.equal(called, 0);
  assert.deepEqual(
    result.runs.map((run) => [run.checkpoint.id, run.status, run.detail]),
    [
      ['ready', 'unsupported', 'Not available on this driver'],
      ['completion', 'unsupported', 'Not available on this driver'],
    ],
  );
  const quality = evaluateQuality({
    platform: 'macos',
    observations: 1,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
    audits: result,
  });
  assert.notEqual(quality.verdict, 'pass');
  assert.ok(quality.unsupported.some((gap) => gap.id === TEST_AUDIT));
});

test('audit exceptions, invalid output and timeouts are errors, never clean', async () => {
  const cases: [string, () => Promise<unknown>, RegExp][] = [
    [
      'analyzer exception',
      async () => {
        throw new Error('axe failed to load');
      },
      /axe failed to load/,
    ],
    [
      'scope selector matched nothing',
      async () => {
        throw new Error('Audit scope main#content matched no element');
      },
      /matched no element/,
    ],
    [
      'invalid output',
      async () => ({ complete: true, findings: [{ ruleId: 'x' }] }),
      /Invalid audit output/,
    ],
    [
      'unsafe guidance link',
      async () => ({
        complete: true,
        findings: [finding({ helpUrl: 'javascript:alert(1)' })],
      }),
      /Invalid audit output: findings.0.helpUrl/,
    ],
  ];
  for (const [name, runAudit, detail] of cases) {
    const result = await driven(runAudit);
    assert.equal(result.runs[0]!.status, 'error', name);
    assert.match(result.runs[0]!.detail ?? '', detail, name);
    assert.deepEqual(result.findings, [], name);
    const quality = evaluateQuality({
      platform: 'web',
      observations: 1,
      findings: [],
      policyBlocks: 0,
      evidenceComplete: true,
      audits: result,
    });
    assert.equal(quality.verdict, 'not_evaluated', name);
    assert.equal(
      quality.executed.find((check) => check.id === TEST_AUDIT)!.status,
      'errored',
    );
  }
  const suite = suiteWith({ audits: { timeoutMs: 1000 } });
  const { runner } = audits(suite, { runAudit: () => new Promise(() => {}) }, [
    testCheck(['ready']),
  ]);
  runner.record(state(0));
  await runner.afterObservation(state(0));
  assert.match(runner.finish().runs[0]!.detail ?? '', /timed out after 1000ms/);
  // A driver without runAudit cannot run a driver audit.
  const missing = audits(suiteWith(), {}, [testCheck(['ready'])]);
  missing.runner.record(state(0));
  await missing.runner.afterObservation(state(0));
  assert.match(
    missing.runner.finish().runs[0]!.detail ?? '',
    /does not implement runAudit/,
  );
});

test('needs-review items are findings on a clean run and never fail quality', async () => {
  const result = await driven({
    complete: true,
    analyzer: { name: 'axe-core', version: '4.10.2' },
    limitations: ['An automated scan does not establish WCAG conformance'],
    findings: [
      finding({
        certainty: 'needs_review',
        severity: 'serious',
        ruleId: 'color-contrast',
      }),
      finding({
        certainty: 'needs_review',
        severity: null,
        ruleId: 'aria-valid-attr-value',
      }),
    ],
  });
  const [run] = result.runs;
  assert.equal(run!.status, 'clean');
  assert.deepEqual(run!.analyzer, { name: 'axe-core', version: '4.10.2' });
  assert.deepEqual(run!.limitations, [
    'An automated scan does not establish WCAG conformance',
  ]);
  assert.deepEqual(
    result.findings.map((entry) => [entry.certainty, entry.gating]),
    [
      ['needs_review', false],
      ['needs_review', false],
    ],
  );
  assert.equal(result.findings[0]!.analyzer!.name, 'axe-core');
  assert.deepEqual(result.findings[0]!.tags, ['wcag2a', 'wcag412']);
  assert.equal(result.findings[0]!.nodeCount, 3);
  assert.equal(result.findings[0]!.targets[0]!.snippet, '<button id="save">');
  const quality = evaluateQuality({
    platform: 'web',
    observations: 1,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
    audits: result,
  });
  assert.equal(quality.verdict, 'pass');
  assert.match(
    quality.executed[0]!.detail ?? '',
    /2 other finding\(s\) below the serious threshold or needing review/,
  );
});

test('violations fail quality at or above the configured severity only', async () => {
  for (const [severity, failOn, verdict] of [
    ['critical', 'serious', 'fail'],
    ['serious', 'serious', 'fail'],
    ['moderate', 'serious', 'pass'],
    ['moderate', 'moderate', 'fail'],
    ['critical', 'none', 'pass'],
    [null, 'critical', 'fail'],
  ] as const) {
    const suite = suiteWith({ audits: { failOn } });
    const { runner } = audits(
      suite,
      {
        runAudit: async () => ({
          complete: true,
          findings: [finding({ severity })],
        }),
      },
      [testCheck(['ready'])],
    );
    runner.record(state(0));
    await runner.afterObservation(state(0));
    const result = runner.finish();
    assert.equal(result.runs[0]!.status, 'findings');
    const quality = evaluateQuality({
      platform: 'web',
      observations: 1,
      findings: [],
      policyBlocks: 0,
      evidenceComplete: true,
      audits: result,
    });
    assert.equal(quality.verdict, verdict, `${severity} vs ${failOn}`);
    assert.equal(isGating(result.findings[0]!, failOn), verdict === 'fail');
  }
});

test('an audit that did not fully run is incomplete and keeps quality from passing', async () => {
  const result = await driven({
    complete: false,
    detail: '2 cross-origin frames were not scanned',
    findings: [],
  });
  assert.equal(result.runs[0]!.status, 'incomplete');
  const quality = evaluateQuality({
    platform: 'web',
    observations: 1,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
    audits: result,
  });
  assert.equal(quality.executed[0]!.status, 'inconclusive');
  assert.equal(quality.verdict, 'not_evaluated');
});

test('audit output is parsed with defaults at the boundary', () => {
  const parsed = auditOutputSchema.parse({
    complete: true,
    findings: [finding({ tags: undefined, nodeCount: undefined })],
  });
  assert.equal(parsed.detail, null);
  assert.equal(parsed.analyzer, null);
  assert.deepEqual(parsed.limitations, []);
  assert.deepEqual(parsed.findings[0]!.tags, []);
  assert.deepEqual(parsed.findings[0]!.files, []);
  assert.throws(() =>
    auditOutputSchema.parse({ complete: true, findings: [], extra: 1 }),
  );
});

// ---- End to end through runSuite ----

const continueAction: Action = {
  kind: 'click',
  id: 'a0',
  description: 'Continue',
  target: { by: 'role', role: 'button', name: 'Continue' },
};
const deterministic: Models = {
  async plan() {
    return { objective: 'Continue', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return {
      type: 'choice',
      choice: actions[0]?.id ?? 'no_match',
      confidence: 1,
      probabilities: {},
    };
  },
};

test('the runner records audit runs in results.json and the report', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-audits-')), 'run');
  let executed = 0;
  const suite = suiteWith(
    {
      audits: {
        checks: [
          {
            id: 'layout.horizontal-overflow',
            at: ['ready', 'states', 'completion'],
          },
        ],
      },
    },
    {
      states: [{ name: 'arrived', when: { kind: 'path', pattern: '^/done$' } }],
    },
  );
  const results = await runSuite(suite, deterministic, {
    directory,
    driver: {
      async openSession() {
        return {
          ...session({
            holds: (condition) => condition.kind === 'path' && executed >= 1,
          }),
          async check(condition: Check) {
            if (condition.kind === 'visible') return true;
            return executed >= 1;
          },
          async observe(step: number, screenshot: string) {
            return { ...state(step, executed ? 25 : 0), screenshot };
          },
          async candidates() {
            return [{ ...continueAction }];
          },
          async execute() {
            executed++;
          },
          async inScope() {
            return true;
          },
        };
      },
      async close() {},
    },
  });
  const [result] = parseResults(JSON.stringify(results));
  assert.equal(result!.resultVersion, 3);
  assert.equal(result!.status, 'passed');
  assert.deepEqual(
    result!.audits.runs.map((run) => [run.checkpoint.id, run.status]),
    [
      ['ready', 'clean'],
      ['state:arrived', 'findings'],
      // No state was observed after the state checkpoint, so completion
      // audits the final observed state again; it still overflows.
      ['completion', 'findings'],
    ],
  );
  assert.equal(result!.quality.verdict, 'fail');
  const report = reportHTML(suite.name, results, directory);
  assert.match(
    report,
    /Audits: 3 run\(s\), 2 violation\(s\), 0 needing manual review/,
  );
  assert.match(report, /Audit violations/);
  assert.match(
    report,
    /Automated audits ran at configured checkpoints \(layout\.horizontal-overflow\); an automated scan does not establish accessibility or standards conformance/,
  );
  assert.match(report, /document-wider-than-viewport/);
});

test('a macOS run reports the overflow audit as unsupported, not clean', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-audits-')), 'run');
  const suite = suiteSchema.parse({
    name: 'native',
    platform: 'macos',
    app: { bundleId: 'dev.example.app' },
    journeys: [
      {
        id: 'find',
        goal: 'Find',
        persona: 'A user',
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Home' },
        },
        success: [
          {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Home' },
          },
        ],
      },
    ],
  });
  const [result] = await runSuite(suite, deterministic, {
    directory,
    driver: {
      async openSession() {
        return {
          ...session({ driver: 'macos' }),
          async check() {
            return true;
          },
          async observe(step: number, screenshot: string) {
            return {
              ...state(step),
              url: 'macos-app://dev.example.app/Home',
              screenshot,
            };
          },
          async inScope() {
            return true;
          },
        };
      },
      async close() {},
    },
  });
  assert.equal(result!.status, 'passed');
  assert.deepEqual(
    result!.audits.runs.map((run) => [
      run.auditId,
      run.checkpoint.id,
      run.status,
    ]),
    [['layout.horizontal-overflow', 'completion', 'unsupported']],
  );
  assert.equal(result!.quality.verdict, 'not_evaluated');
  assert.match(
    reportHTML(suite.name, [result!], directory),
    /No automated audit ran; this is not an accessibility audit/,
  );
});

test('a journey stopped before ready lists its audit checkpoints as not reached', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-audits-')), 'run');
  const suite = suiteWith({}, { maxDurationMs: 1000 });
  const [result] = await runSuite(suite, deterministic, {
    directory,
    driver: {
      async openSession() {
        return session({ holds: () => false });
      },
      async close() {},
    },
  });
  assert.equal(result!.outcome.code, 'ready_not_reached');
  assert.deepEqual(result!.audits.runs, []);
  assert.deepEqual(result!.audits.notReached, [
    { auditId: 'layout.horizontal-overflow', at: 'completion' },
  ]);
  assert.ok(
    result!.quality.skipped.some(
      (gap) => gap.id === 'layout.horizontal-overflow',
    ),
  );
});

test('the overflow audit measures a real Chromium page end to end', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url === '/wide'
        ? '<h1>Home</h1><p data-testid="done">Done</p><div style="width:1400px">Wide</div>'
        : '<h1>Home</h1><a href="/wide">Open wide page</a>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const suite = suiteSchema.parse({
      name: 'overflow',
      baseURL: `http://127.0.0.1:${port}`,
      viewports: [{ name: 'narrow', width: 390, height: 844 }],
      audits: {
        checks: [
          { id: 'layout.horizontal-overflow', at: ['ready', 'completion'] },
        ],
      },
      journeys: [
        {
          ...journey,
          allowedPaths: ['/', '/wide'],
          success: [{ kind: 'path', pattern: '^/wide$' }],
          maxSteps: 3,
          maxDurationMs: 20000,
        },
      ],
    });
    const models: Models = {
      async plan() {
        return { objective: 'Open the wide page', concerns: [] };
      },
      async choose(_journey, _observation, _plan, actions) {
        return {
          type: 'choice',
          choice:
            actions.find((action) => action.kind === 'link')?.id ?? 'no_match',
          confidence: 1,
          probabilities: {},
        };
      },
    };
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-audits-')),
      'run',
    );
    const [result] = await runSuite(suite, models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    assert.deepEqual(
      result!.audits.runs.map((run) => [run.checkpoint.id, run.status]),
      [
        ['ready', 'clean'],
        ['completion', 'findings'],
      ],
    );
    const [overflow] = result!.audits.findings;
    assert.match(overflow!.description, /\d+px wider than the viewport/);
    assert.equal(overflow!.reproduction.viewport.width, 390);
    assert.match(overflow!.reproduction.url ?? '', /\/wide$/);
    assert.equal(result!.quality.verdict, 'fail');
  } finally {
    server.close();
  }
});

test('driver audits get the session viewport, a per-audit timeout and report exemptions', async () => {
  const requests: DriverAuditRequest[] = [];
  const suite = suiteWith({ audits: { timeoutMs: 1000 } });
  const { runner } = audits(
    suite,
    {
      runAudit: async (request) => {
        requests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return {
          complete: true,
          exemptions: [
            {
              ruleId: 'overlap',
              target: { description: 'Hero carousel', selector: '.carousel' },
              reason: 'Configured exception: intentional carousel overflow',
            },
          ],
          findings: [
            finding({
              certainty: 'needs_review',
              ruleId: 'color-contrast',
              targets: [
                {
                  description: 'Sign up link',
                  selector: 'iframe#promo >>> a.cta',
                  reason: 'background gradient',
                },
              ],
            }),
          ],
        };
      },
    },
    [{ ...testCheck(['ready']), timeoutMs: 3000 } as AuditConfig],
  );
  runner.record(state(0));
  await runner.afterObservation(state(0));
  const result = runner.finish();
  // The entry's own timeout overrode the suite's 1000ms.
  assert.equal(result.runs[0]!.status, 'clean', result.runs[0]!.detail ?? '');
  assert.equal(requests[0]!.timeoutMs, 3000);
  assert.deepEqual(requests[0]!.viewport, {
    name: 'desktop',
    width: 800,
    height: 600,
  });
  assert.equal(result.runs[0]!.exemptions[0]!.target.selector, '.carousel');
  assert.equal(result.runs[0]!.exemptions[0]!.target.reason, null);
  assert.equal(result.findings[0]!.targets[0]!.reason, 'background gradient');
  assert.equal(result.findings[0]!.targets[0]!.description, 'Sign up link');
  assert.equal(
    suiteWith({
      audits: {
        checks: [{ id: 'layout.horizontal-overflow', timeoutMs: 60000 }],
      },
    }).audits.checks[0]!.timeoutMs,
    60000,
  );
});
