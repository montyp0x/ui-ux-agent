// performance.web: real Chromium runs against the local performance site
// (examples/performance-fixture.ts) with scripted decisions (no model calls),
// plus the pure measurement and comparison rules. Timing assertions compare
// a slow page with its fast twin, or a throttled run with an unthrottled one,
// with wide margins: never exact milliseconds.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { suiteSchema, type Action, type Choice, type Suite } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import { parseResults, type Result } from '../src/results.js';
import { reportHTML } from '../src/report.js';
import { evaluateQuality, NOT_IMPLEMENTED_CHECKS } from '../src/quality.js';
import {
  cumulativeLayoutShift,
  interactionToNextPaint,
  performanceMeasurement,
  performanceOutput,
  rawPerformanceSchema,
  type RawPerformance,
} from '../src/audits/performance.js';
import type { PerformanceMeasurement } from '../src/audits/performance-contract.js';
import { comparePerformance, compareRuns, loadRun } from '../src/compare.js';
import { gateSchema } from '../src/gate.js';
import { JourneyAudits } from '../src/audits/run.js';
import { configuredChecks } from '../src/audits/config.js';
import { auditOutputSchema } from '../src/audits/contract.js';
import {
  performanceWebPlaywrightAudit,
  preparePerformance,
} from '../src/drivers/playwright-performance.js';
import type { UISession } from '../src/drivers/types.js';
import { performanceSite, SLOW } from '../examples/performance-fixture.js';

const role = (name: string) => ({ by: 'role', role: 'button', name }) as const;
const journeyConfig = {
  id: 'apply',
  goal: 'Apply the billing changes',
  persona: 'A billing admin',
  startPath: '/',
  allowedPaths: ['/', '/work', '/hanging'],
  ready: { kind: 'visible', target: { by: 'testId', value: 'promo' } },
  success: [
    { kind: 'text', target: { by: 'testId', value: 'status' }, pattern: '^Applied$' },
  ],
  interactions: [{ kind: 'click', target: role('Apply'), description: 'Apply the changes' }],
  maxSteps: 4,
  maxDurationMs: 60000,
};

const suiteFor = (
  url: string,
  check: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Suite =>
  suiteSchema.parse({
    name: 'LOCAL performance fixture',
    baseURL: url,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [journeyConfig],
    audits: { checks: [{ id: 'performance.web', ...check }] },
    ...extra,
  }) as Suite;

const choice = (actions: Action[], id: string): Choice => ({
  type: 'choice',
  choice: id,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === id ? 1 : 0]),
    ['no_match', id === 'no_match' ? 1 : 0],
  ]),
});
// Clicks Apply; scripted, so no model is called.
const scripted: Models = {
  async plan() {
    return { objective: 'Apply the changes', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return choice(
      actions,
      actions.find((action) => action.kind === 'click')?.id ?? 'no_match',
    );
  },
};

async function run(
  suite: Suite,
  options: { browser?: 'chromium' | 'webkit'; directory?: string } = {},
): Promise<{ result: Result; directory: string }> {
  const directory =
    options.directory ??
    join(await mkdtemp(join(tmpdir(), 'ui-ux-performance-')), 'run');
  if (options.browser) suite.browser = options.browser;
  const [result] = await runSuite(suite, scripted, { directory, env: {} });
  assert.ok(result);
  return { result, directory };
}

const perf = (result: Result, checkpoint: string) => {
  const entry = result.audits.runs.find(
    (item) => item.auditId === 'performance.web' && item.checkpoint.id === checkpoint,
  );
  assert.ok(entry, `no performance.web run at ${checkpoint}`);
  return entry;
};
const measured = (result: Result, checkpoint: string): PerformanceMeasurement => {
  const entry = perf(result, checkpoint);
  assert.ok(entry.performance, `${checkpoint}: ${entry.status} ${entry.detail}`);
  return entry.performance;
};

// ------------------------------------------------------------- config

test('performance.web is opt-in, runs at ready and completion, and budgets need an explicit severity', () => {
  const plain = suiteSchema.parse({
    name: 'x',
    baseURL: 'http://127.0.0.1:1',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [journeyConfig],
  });
  assert.ok(!configuredChecks(plain.audits).some((check) => check.id === 'performance.web'));
  const check = suiteFor('http://127.0.0.1:1').audits.checks![0]!;
  assert.equal(check.id, 'performance.web');
  if (check.id !== 'performance.web') return;
  assert.deepEqual(check.at, ['ready', 'completion']);
  assert.deepEqual(check.budgets, []);
  assert.equal(check.conditions, undefined);
  assert.throws(() =>
    suiteFor('http://127.0.0.1:1', { budgets: [{ metric: 'lcpMs', max: 2500 }] }),
  );
  assert.throws(() =>
    suiteFor('http://127.0.0.1:1', {
      budgets: [
        { metric: 'lcpMs', max: 2500, severity: 'serious' },
        { metric: 'lcpMs', max: 4000, severity: 'minor' },
      ],
    }),
  );
  assert.throws(() => suiteFor('http://127.0.0.1:1', { budgets: [{ metric: 'speed', max: 1, severity: 'minor' }] }));
  assert.throws(() => suiteFor('http://127.0.0.1:1', { conditions: {} }));
  assert.throws(() => suiteFor('http://127.0.0.1:1', { conditions: { cpuSlowdown: 50 } }));
  assert.throws(() => suiteFor('http://127.0.0.1:1', { conditions: { network: 'dial-up' } }));
  assert.throws(() => suiteFor('http://127.0.0.1:1', { score: true }));
  const custom = suiteFor('http://127.0.0.1:1', {
    conditions: { network: { latencyMs: 300, downloadKbps: 1000, uploadKbps: 500 }, cpuSlowdown: 4 },
  }).audits.checks![0]!;
  assert.equal(custom.id === 'performance.web' && custom.conditions?.cpuSlowdown, 4);
});

test('the performance example suite parses with its conditions and budgets', async () => {
  const suite = suiteSchema.parse(JSON.parse(await readFile('examples/performance.json', 'utf8')));
  const check = suite.audits.checks!.find((entry) => entry.id === 'performance.web');
  assert.ok(check && check.id === 'performance.web');
  assert.equal(check.conditions?.cpuSlowdown, 2);
  assert.deepEqual(check.budgets.map((budget) => budget.metric), ['lcpMs', 'cls', 'inpMs']);
});

// --------------------------------------------------------------- rules

test('CLS is the largest burst of shifts, and INP ignores one interaction in fifty', () => {
  assert.equal(cumulativeLayoutShift([]), 0);
  // Two bursts: 0.1+0.1 (500 ms apart) and 0.15 alone after a 2 s gap.
  assert.equal(
    cumulativeLayoutShift([
      { startTime: 100, value: 0.1 },
      { startTime: 600, value: 0.1 },
      { startTime: 2600, value: 0.15 },
    ]),
    0.2,
  );
  // A burst is cut at 5 s even when shifts keep coming.
  const steady = Array.from({ length: 12 }, (_, index) => ({ startTime: index * 900, value: 0.01 }));
  assert.ok(cumulativeLayoutShift(steady) <= 0.06 + 1e-9);
  assert.equal(interactionToNextPaint([]), null);
  assert.equal(interactionToNextPaint([40, 300, 120]), 300);
  // 60 interactions: the slowest is ignored, the second slowest counts.
  assert.equal(interactionToNextPaint([900, 500, ...Array<number>(58).fill(20)]), 500);
  // The value falls on an interaction Event Timing did not report (< 16 ms).
  assert.equal(interactionToNextPaint([null, null]), null);
});

const raw = (overrides: Partial<RawPerformance> = {}): RawPerformance =>
  rawPerformanceSchema.parse({
    installed: true,
    url: 'http://127.0.0.1:1/billing?token=abc',
    timeOrigin: 1_000_000,
    now: 5000,
    supported: ['navigation', 'paint', 'largest-contentful-paint', 'layout-shift', 'event', 'longtask'],
    navigation: {
      type: 'navigate',
      activationStart: 0,
      responseStart: 20,
      responseEnd: 30,
      domContentLoadedEventEnd: 80,
      loadEventEnd: 400,
    },
    paints: [{ name: 'first-contentful-paint', startTime: 90 }],
    lcp: [{ startTime: 900, size: 5000, element: 'h1#hero' }],
    shifts: [{ startTime: 700, value: 0.12, hadRecentInput: false }],
    events: [],
    inputs: [],
    longTasks: [{ startTime: 500, duration: 150 }],
    dropped: 0,
    errors: [],
    ...overrides,
  });
const context = (check: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const config = suiteFor('http://127.0.0.1:1', check).audits.checks![0]!;
  if (config.id !== 'performance.web') throw new Error('not performance.web');
  return {
    config,
    browser: 'chromium',
    conditions: { networkProfile: null, network: null, cpuSlowdown: null, applied: true },
    harnessIntervals: [],
    harness: null,
    loadWaitedMs: null,
    ...extra,
  };
};

test('without budgets the audit only measures: no finding, and it says so', () => {
  const output = performanceOutput(raw(), context());
  assert.equal(output.complete, true);
  assert.deepEqual(output.findings, []);
  assert.ok(output.limitations!.some((text) => /No budgets configured/.test(text)));
  const metrics = output.performance!.metrics;
  assert.equal(metrics.lcpMs, 900);
  assert.equal(metrics.cls, 0.12);
  assert.equal(metrics.blockingTimeMs, 100);
  assert.equal(metrics.inpMs, null);
  // Path only: no origin or query in the measurement.
  assert.equal(output.performance!.document.path, '/billing');
});

test('a budget breach is a violation at the budget severity; a budget it cannot evaluate is never a pass', () => {
  const output = performanceOutput(
    raw(),
    context({
      budgets: [
        { metric: 'lcpMs', max: 500, severity: 'serious' },
        { metric: 'cls', max: 0.25, severity: 'moderate' },
        { metric: 'inpMs', max: 200, severity: 'serious' },
      ],
    }),
  );
  assert.equal(output.complete, true);
  assert.equal(output.findings.length, 1);
  const finding = output.findings[0]!;
  assert.equal(finding.ruleId, 'performance-budget.lcpMs');
  assert.equal(finding.severity, 'serious');
  assert.equal(finding.certainty, 'violation');
  assert.match(finding.description, /900 ms exceeds the suite budget of 500 ms/);
  assert.match(finding.targets[0]!.reason ?? '', /h1#hero/);
  assert.deepEqual(
    output.performance!.budgets.map((budget) => [budget.metric, budget.status]),
    [
      ['lcpMs', 'exceeded'],
      ['cls', 'within'],
      ['inpMs', 'not_measured'],
    ],
  );
  assert.ok(output.limitations!.some((text) => /Budget on inpMs not evaluated/.test(text)));
  // A browser that does not report layout shifts: cls is null, not 0, and
  // its budget makes the run incomplete.
  const webkitLike = performanceOutput(
    raw({ supported: ['navigation', 'paint', 'largest-contentful-paint', 'event'] }),
    context({ budgets: [{ metric: 'cls', max: 0.1, severity: 'serious' }] }, { browser: 'webkit' }),
  );
  assert.equal(webkitLike.complete, false);
  assert.match(webkitLike.detail ?? '', /webkit does not report cls/);
  assert.equal(webkitLike.performance!.metrics.cls, null);
  assert.equal(webkitLike.performance!.metrics.blockingTimeMs, null);
  assert.deepEqual(webkitLike.performance!.unsupported, ['cls', 'blockingTimeMs']);
  // Not instrumented: no measurement at all.
  const bare = performanceOutput(raw({ installed: false }), context());
  assert.equal(bare.complete, false);
  assert.equal(bare.performance, null);
});

test('entries recorded while another audit ran in the page are reported apart from the app metrics', () => {
  // Another audit ran from 600 to 760 ms after time origin.
  const interval = { start: 1_000_600, end: 1_000_660 };
  const measurement = performanceMeasurement(
    raw({
      lcp: [
        { startTime: 300, size: 4000, element: 'p' },
        { startTime: 640, size: 9000, element: 'div.sweep' },
      ],
      shifts: [
        { startTime: 640, value: 0.4, hadRecentInput: false },
        { startTime: 2000, value: 0.02, hadRecentInput: false },
        { startTime: 3000, value: 0.3, hadRecentInput: true },
      ],
      longTasks: [
        { startTime: 100, duration: 90 },
        { startTime: 610, duration: 300 },
      ],
    }),
    context({}, { harnessIntervals: [interval] }),
  );
  assert.equal(measurement.metrics.lcpMs, 300);
  assert.equal(measurement.lcpElement, 'p');
  assert.equal(measurement.metrics.cls, 0.02);
  assert.equal(measurement.metrics.blockingTimeMs, 40);
  assert.deepEqual(measurement.longTasks, {
    app: { count: 1, blockingMs: 40 },
    duringHarness: { count: 1, blockingMs: 250 },
  });
  assert.deepEqual(measurement.excludedDuringHarness, {
    layoutShifts: 1,
    lcpCandidates: 1,
    interactions: 0,
  });
});

test('interactions: the slowest selected one is INP; interactions too fast to report are counted, not invented', () => {
  const event = (id: number, duration: number, target: string, matches: number[], startTime = 1000) => ({
    name: 'click',
    startTime,
    duration,
    processingStart: startTime + 4,
    processingEnd: startTime + duration - 10,
    interactionId: id,
    target,
    matches,
  });
  const input = (target: string, matches: number[]) => ({ type: 'pointerdown', at: 1000, target, matches });
  const selected = performanceMeasurement(
    raw({
      events: [event(1, 304, 'button#apply', [0]), event(2, 96, 'a.help', [])],
      inputs: [input('button#apply', [0]), input('a.help', []), input('button#apply', [0])],
    }),
    context({ interactionTargets: ['#apply'] }),
  );
  assert.equal(selected.metrics.inpMs, 304);
  assert.equal(selected.interactions.count, 3);
  assert.equal(selected.interactions.selected, 2);
  assert.deepEqual(
    selected.interactions.slowest.map((entry) => [entry.target, entry.selected, entry.inputDelayMs, entry.presentationMs]),
    [
      ['button#apply', true, 4, 10],
      ['a.help', false, 4, 10],
    ],
  );
  // Only the unselected interaction was slow: the selected ones were all
  // under 16 ms, so inpMs is null and a budget at or over 16 ms holds.
  const fast = performanceOutput(
    raw({
      events: [event(2, 400, 'a.help', [])],
      inputs: [input('button#apply', [0]), input('a.help', [])],
    }),
    context({ interactionTargets: ['#apply'], budgets: [{ metric: 'inpMs', max: 100, severity: 'serious' }] }),
  );
  assert.equal(fast.performance!.metrics.inpMs, null);
  assert.equal(fast.performance!.budgets[0]!.status, 'within');
  assert.deepEqual(fast.findings, []);
  assert.ok(fast.limitations!.some((text) => /under 16 ms/.test(text)));
});

test('the macOS driver reports performance.web as unsupported, never clean', async () => {
  const suite = suiteFor('http://127.0.0.1:1');
  const session = {
    driver: 'macos',
    browserErrors: [],
    unauthorized: false,
    location: () => 'app://x',
    check: async () => false,
  } as unknown as UISession;
  const audits = new JourneyAudits({
    suite,
    journey: suite.journeys[0]!,
    viewport: { name: 'desktop', width: 800, height: 600 },
    directory: '/tmp/run',
    session,
    log: async () => {},
  });
  audits.record({ step: 0, url: 'app://x', fingerprint: 'f' } as never);
  await audits.completion(0, null);
  const [entry] = audits.finish().runs;
  assert.equal(entry!.status, 'unsupported');
  assert.equal(entry!.performance, undefined);
});

// --------------------------------------------------------- real runs

test('a slow page measures slower than its fast twin on every seeded defect, and app time excludes harness time', async () => {
  const site = await performanceSite();
  try {
    const slowRun = await run(suiteFor(site.url));
    const slow = slowRun.result;
    site.state.mode = 'fast';
    const fast = (await run(suiteFor(site.url))).result;
    for (const result of [slow, fast]) {
      assert.equal(result.status, 'passed', result.reason);
      assert.equal(perf(result, 'ready').status, 'clean');
      assert.equal(perf(result, 'completion').status, 'clean');
      assert.equal(result.audits.findings.length, 0);
    }
    const slowReady = measured(slow, 'ready');
    const fastReady = measured(fast, 'ready');
    // LCP waits for the delayed API response in the slow page.
    assert.ok(slowReady.metrics.lcpMs! >= SLOW.scriptDelayMs - 50, `slow lcp ${slowReady.metrics.lcpMs}`);
    assert.ok(fastReady.metrics.lcpMs! < slowReady.metrics.lcpMs! - 300, `fast lcp ${fastReady.metrics.lcpMs}`);
    assert.equal(slowReady.lcpElement, 'h1#hero');
    for (const measurement of [slowReady, fastReady]) {
      assert.ok(measurement.metrics.ttfbMs! >= 0);
      assert.ok(measurement.metrics.fcpMs! > 0);
      assert.ok(measurement.metrics.loadMs! >= measurement.metrics.domContentLoadedMs!);
      assert.deepEqual(measurement.unsupported, []);
      assert.equal(measurement.conditions.applied, true);
      assert.equal(measurement.conditions.network, null);
      assert.equal(measurement.browser, 'chromium');
    }
    const slowEnd = measured(slow, 'completion');
    const fastEnd = measured(fast, 'completion');
    // The banner inserted above the content shifts it.
    assert.ok(slowEnd.metrics.cls! > 0.05, `slow cls ${slowEnd.metrics.cls}`);
    assert.ok(fastEnd.metrics.cls! < 0.01, `fast cls ${fastEnd.metrics.cls}`);
    // The 150 ms task at load blocks for about 100 ms.
    assert.ok(slowEnd.metrics.blockingTimeMs! >= 70, `slow blocking ${slowEnd.metrics.blockingTimeMs}`);
    assert.equal(fastEnd.metrics.blockingTimeMs, 0);
    // The Apply handler busy-waits in the slow page only.
    assert.equal(slowEnd.interactions.count, 1);
    assert.ok(slowEnd.metrics.inpMs! >= SLOW.handlerMs - 20, `slow inp ${slowEnd.metrics.inpMs}`);
    assert.ok(slowEnd.interactions.slowest[0]!.processingMs >= SLOW.handlerMs - 20);
    assert.match(slowEnd.interactions.slowest[0]!.target ?? '', /^button#apply/);
    assert.equal(fastEnd.interactions.count, 1);
    assert.ok(fastEnd.metrics.inpMs === null || fastEnd.metrics.inpMs < 100, `fast inp ${fastEnd.metrics.inpMs}`);
    // Harness work is reported beside the metrics, never in them.
    const harness = slowEnd.harness!;
    assert.ok(harness.screenshots >= 1);
    assert.ok(harness.screenshotMs > 0);
    assert.ok(harness.auditMs > 0, 'the ready run counts as earlier audit time');
    assert.equal(harness.modelCalls, 0);
    assert.ok(harness.elapsedMs >= harness.screenshotMs + harness.auditMs);
    assert.ok(slowEnd.document.ageMs > slowEnd.metrics.loadMs!);
    // The quality verdict passes on a measurement without budgets.
    assert.equal(slow.quality.verdict, 'pass', slow.quality.reason);
    // The report shows metrics and harness time apart.
    const html = reportHTML('perf', [slow], slowRun.directory);
    assert.match(html, /Performance/);
    assert.match(html, /Largest contentful paint/);
    assert.match(html, /harness/i);
  } finally {
    await site.close();
  }
});

test('budgets: a breach fails quality at its severity; one below failOn is reported without gating', async () => {
  const site = await performanceSite();
  try {
    const { result } = await run(
      suiteFor(site.url, {
        at: ['completion'],
        budgets: [
          { metric: 'lcpMs', max: 300, severity: 'serious' },
          { metric: 'cls', max: 0.01, severity: 'minor' },
          { metric: 'loadMs', max: 60000, severity: 'critical' },
        ],
      }),
    );
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(perf(result, 'completion').status, 'findings');
    const findings = result.audits.findings.map((finding) => [finding.ruleId, finding.severity, finding.gating]);
    assert.deepEqual(findings, [
      ['performance-budget.lcpMs', 'serious', true],
      ['performance-budget.cls', 'minor', false],
    ]);
    assert.equal(result.quality.verdict, 'fail');
    parseResults(JSON.stringify([result]));
  } finally {
    await site.close();
  }
});

test('CPU and network conditions are applied in Chromium and recorded with the measurement', async (t) => {
  const site = await performanceSite();
  site.state.mode = 'fast';
  try {
    const work = { ...journeyConfig, startPath: '/work?n=160000000' };
    const base = suiteFor(site.url, { at: ['completion'] }, { journeys: [work] });
    const plain = measured((await run(base)).result, 'completion');
    const cpu = measured(
      (await run(suiteFor(site.url, { at: ['completion'], conditions: { cpuSlowdown: 6 } }, { journeys: [work] }))).result,
      'completion',
    );
    assert.equal(cpu.conditions.applied, true);
    assert.equal(cpu.conditions.cpuSlowdown, 6);
    const busy = (measurement: PerformanceMeasurement) =>
      measurement.longTasks.app.blockingMs + 50 * measurement.longTasks.app.count;
    const slowed = `throttled ${busy(cpu)} vs ${busy(plain)}`;
    // On GitHub's Windows runners the effect of the same 6x rate varied from
    // 1.1x to over 2x between runs, while a Windows desktop measured 6.6-6.9x
    // every time: the hosted VM, not the code path, decides it there. The
    // ratio is reported, not asserted, on Windows CI (README, Current limits).
    if (process.platform === 'win32' && process.env.CI)
      t.diagnostic(`cpuSlowdown 6 on a Windows CI runner: ${slowed}`);
    else assert.ok(busy(cpu) > busy(plain) * 2, slowed);
    const network = measured(
      (await run(suiteFor(site.url, { at: ['ready'], conditions: { network: { latencyMs: 600, downloadKbps: 5000, uploadKbps: 5000 } } }))).result,
      'ready',
    );
    const unthrottled = measured((await run(suiteFor(site.url, { at: ['ready'] }))).result, 'ready');
    assert.equal(network.conditions.networkProfile, 'custom');
    assert.deepEqual(network.conditions.network, { latencyMs: 600, downloadKbps: 5000, uploadKbps: 5000 });
    assert.ok(network.metrics.fcpMs! >= unthrottled.metrics.fcpMs! + 400, `fcp ${network.metrics.fcpMs} vs ${unthrottled.metrics.fcpMs}`);
    assert.ok(network.metrics.loadMs! >= unthrottled.metrics.loadMs! + 400);
  } finally {
    await site.close();
  }
});

test('a page whose load event never fires is measured within the audit timeout, with loadMs null', async () => {
  const site = await performanceSite();
  const browser = await chromium.launch();
  try {
    const suite = suiteFor(site.url, {
      at: ['ready'],
      budgets: [{ metric: 'loadMs', max: 1000, severity: 'serious' }],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = await preparePerformance(context, page, suite, 'chromium', async () => {});
    await page.goto(`${site.url}/hanging`, { waitUntil: 'domcontentloaded' });
    const started = Date.now();
    const output = auditOutputSchema.parse(
      await performanceWebPlaywrightAudit(
        page,
        {
          config: suite.audits.checks![0]!,
          checkpoint: { id: 'ready', kind: 'ready', name: null, step: 0, url: page.url(), screenshot: null },
          viewport: { name: 'desktop', width: 1280, height: 800 },
          directory: '/tmp/unused',
          scope: { suite: suite.name, journey: 'apply' },
          baselines: null,
          timeoutMs: 2500,
          harness: null,
        },
        recorder,
      ),
    );
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
    assert.equal(output.complete, true);
    assert.equal(output.performance!.metrics.loadMs, null);
    assert.ok(output.performance!.metrics.domContentLoadedMs! >= 0);
    assert.equal(output.performance!.budgets[0]!.status, 'not_measured');
    assert.deepEqual(output.findings, []);
    assert.ok(output.limitations.some((text) => /load event had not fired/.test(text)));
    assert.equal(output.performance!.harness, null);
  } finally {
    await browser.close();
    await site.close();
  }
});

// Playwright's WebKit, when it is installed and can start here (CI
// installs Chromium only): the reason to skip otherwise.
async function webkitUnavailable(): Promise<string | null> {
  if (!existsSync(webkit.executablePath())) return 'Playwright WebKit is not installed';
  try {
    const browser = await webkit.launch({ timeout: 10000 });
    await browser.close();
    return null;
  } catch (caught) {
    return `Playwright WebKit cannot start here: ${String(caught instanceof Error ? caught.message : caught).split('\n')[0]}`;
  }
}

test('outside Chromium: configured conditions make every run unsupported; unthrottled runs leave unreported metrics null', async (t) => {
    const unavailable = await webkitUnavailable();
    if (unavailable) return t.skip(unavailable);
    const site = await performanceSite();
    try {
      const throttled = (
        await run(suiteFor(site.url, { conditions: { cpuSlowdown: 4 } }), { browser: 'webkit' })
      ).result;
      for (const checkpoint of ['ready', 'completion']) {
        const entry = perf(throttled, checkpoint);
        assert.equal(entry.status, 'unsupported');
        assert.match(entry.detail ?? '', /Chromium/);
        assert.equal(entry.performance, undefined);
      }
      assert.notEqual(throttled.quality.verdict, 'pass');
      const plain = (await run(suiteFor(site.url), { browser: 'webkit' })).result;
      const measurement = measured(plain, 'ready');
      assert.equal(measurement.browser, 'webkit');
      assert.ok(measurement.metrics.loadMs !== null);
      // WebKit reports neither layout shifts nor long tasks.
      assert.ok(measurement.unsupported.includes('cls'));
      assert.ok(measurement.unsupported.includes('blockingTimeMs'));
      assert.equal(measurement.metrics.cls, null);
      assert.equal(measurement.metrics.blockingTimeMs, null);
      assert.ok(measurement.metrics.fcpMs !== null);
    } finally {
      await site.close();
    }
});

// ---------------------------------------------------------- comparison

test('compare: compatible measurements get medians and deltas; different conditions are incompatible, never compared', async () => {
  const site = await performanceSite();
  try {
    const suite = () => suiteFor(site.url, { at: ['completion'], budgets: [{ metric: 'lcpMs', max: 400, severity: 'serious' }] });
    const before = await run(suite());
    site.state.mode = 'fast';
    const after = await run(suite());
    const comparison = compareRuns(
      await loadRun(before.directory, 'base'),
      await loadRun(after.directory, 'candidate'),
      gateSchema.parse({}),
    );
    assert.equal(comparison.compatible, true, JSON.stringify(comparison.incompatibilities));
    const lcp = comparison.performance.find((entry) => entry.metric === 'lcpMs')!;
    assert.equal(lcp.status, 'compared');
    assert.equal(lcp.checkpoint, 'completion');
    assert.equal(lcp.path, '/');
    assert.equal(lcp.base!.samples, 1);
    assert.ok(lcp.delta! < -300, `delta ${lcp.delta}`);
    assert.ok(!('score' in comparison));
    // The breach found before is resolved after.
    assert.equal(comparison.findings.resolved.length, 1);
    // A measurement taken under other conditions is not compared.
    const file = join(after.directory, 'results.json');
    const results = JSON.parse(await readFile(file, 'utf8')) as Result[];
    for (const entry of results[0]!.audits.runs)
      if (entry.performance) entry.performance.conditions.cpuSlowdown = 4;
    await writeFile(file, JSON.stringify(results));
    const mixed = compareRuns(
      await loadRun(before.directory, 'base'),
      await loadRun(after.directory, 'candidate'),
      gateSchema.parse({}),
    );
    const entries = mixed.performance.filter((entry) => entry.checkpoint === 'completion');
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(entry.status, 'incompatible');
      assert.equal(entry.delta, null);
      assert.match(entry.reason ?? '', /conditions/);
    }
  } finally {
    await site.close();
  }
});

test('compare: measurements of different environments or engines are never compared with each other', async () => {
  const site = await performanceSite();
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-performance-envs-')), 'run');
    const results = await runSuite(
      suiteFor(site.url, { at: ['completion'] }, {
        environments: [
          { name: 'light', colorScheme: 'light' },
          { name: 'dark', colorScheme: 'dark' },
        ],
        combinations: [
          { environment: 'light', viewport: 'desktop' },
          { environment: 'dark', viewport: 'desktop' },
        ],
      }),
      scripted,
      { directory, env: {} },
    );
    assert.equal(results.length, 2);
    // Each environment is its own comparison entry, with one sample: light
    // and dark measurements are never pooled into one median.
    const lcp = comparePerformance(results, results).filter(
      (entry) => entry.metric === 'lcpMs',
    );
    assert.deepEqual(
      lcp.map((entry) => [entry.environment, entry.status, entry.base?.samples]),
      [
        ['dark', 'compared', 1],
        ['light', 'compared', 1],
      ],
    );
    // The same environment measured on another engine is not compared.
    const otherEngine = structuredClone(results).map((result) => {
      for (const run of result.audits.runs)
        if (run.performance) run.performance.browser = 'webkit';
      return result;
    });
    for (const entry of comparePerformance(results, otherEngine)) {
      assert.equal(entry.status, 'incompatible', `${entry.environment} ${entry.metric}`);
      assert.equal(entry.delta, null);
    }
  } finally {
    await site.close();
  }
});

test('kept defaults: an unconfigured performance.web is no quality gap; a breach is one finding per checkpoint; comparison deltas never gate', async () => {
  // Not configured: nothing about performance is listed as missing.
  assert.ok(!NOT_IMPLEMENTED_CHECKS.some((gap) => /performance/.test(gap.id)));
  const quality = evaluateQuality({
    platform: 'web',
    observations: 1,
    findings: [],
    policyBlocks: 0,
    evidenceComplete: true,
  });
  assert.ok(
    ![...quality.unsupported, ...quality.skipped].some((gap) => /performance/.test(gap.id)),
  );
  const site = await performanceSite();
  try {
    // A budget every page breaches: one finding at each checkpoint.
    const breached = await run(
      suiteFor(site.url, { budgets: [{ metric: 'loadMs', max: 0, severity: 'moderate' }] }),
    );
    const breaches = breached.result.audits.findings.filter(
      (finding) => finding.ruleId === 'performance-budget.loadMs',
    );
    assert.deepEqual(
      breaches.map((finding) => finding.checkpoints[0]).sort(),
      ['completion', 'ready'],
    );
    // Without budgets, a candidate ten times slower changes the deltas only:
    // the comparison gate passes.
    const plain = await run(suiteFor(site.url, { at: ['completion'] }));
    const base = await loadRun(plain.directory, 'base');
    const slower = structuredClone(base.results!).map((result) => {
      for (const entry of result.audits.runs)
        if (entry.performance)
          for (const metric of Object.keys(entry.performance.metrics) as (keyof typeof entry.performance.metrics)[])
            if (entry.performance.metrics[metric] !== null)
              entry.performance.metrics[metric] = entry.performance.metrics[metric]! * 10 + 100;
      return result;
    });
    const comparison = compareRuns(
      base,
      { ...base, directory: `${plain.directory}-candidate`, results: slower },
      gateSchema.parse({}),
    );
    assert.ok(comparison.performance.some((entry) => entry.status === 'compared' && entry.delta! > 0));
    assert.equal(comparison.gate?.passed, true, JSON.stringify(comparison.gate?.failures));
  } finally {
    await site.close();
  }
});
