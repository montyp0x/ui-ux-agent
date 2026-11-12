// performance.web: navigation timing and Web Vitals of the document under
// test, read from the browser's own performance timeline at the audit's
// checkpoints, with optional suite-owned budgets.
//
// The web driver installs a fixed collector script before the first
// navigation (src/drivers/playwright-performance.ts) and, when the suite asks
// for it, applies network and CPU conditions to the session (Chromium only;
// elsewhere every run is unsupported, never measured unthrottled in their
// place). This module turns what the collector recorded into a measurement:
//
// - metrics come from browser timestamps, so model calls, screenshots and
//   waits between actions are not in them; harness time is reported beside
//   them (`harness`), never subtracted from or added to them;
// - entries recorded while another audit ran in the page (axe-core scans,
//   breakpoint sweeps) are counted under `duringHarness` /
//   `excludedDuringHarness` and left out of the metrics;
// - a metric the browser does not report is null and listed as unsupported,
//   never 0; a budget on it makes the run incomplete;
// - without budgets the audit only measures and never produces a finding.
import { z } from 'zod';
import type { AuditConfig } from './config.js';
import type { AuditOutput, AuditOutputFinding } from './contract.js';
import type { AuditDefinition } from './registry.js';
import {
  NETWORK_PRESETS,
  PERFORMANCE_METRICS,
  type BudgetResult,
  type HarnessTiming,
  type PerformanceConditionsRecord,
  type PerformanceInteraction,
  type PerformanceMeasurement,
  type PerformanceMetric,
} from './performance-contract.js';

export type PerformanceAuditConfig = Extract<
  AuditConfig,
  { id: 'performance.web' }
>;

// ------------------------------------------------- collector output (raw)

const time = z.number().finite();
const nonnegative = z.number().finite().nonnegative();
const short = (max: number) => z.string().max(max);
const description = z.string().min(1).max(200).nullable();
// Each list is capped by the collector; the schema refuses anything larger.
const CAP = 500;

// What the collector script hands back from the page. Parsed here, at the
// driver boundary: the page could have tampered with any of it.
export const rawPerformanceSchema = z
  .object({
    installed: z.boolean(),
    url: short(4000),
    timeOrigin: nonnegative,
    now: nonnegative,
    supported: z.array(short(60)).max(60),
    navigation: z
      .object({
        type: short(40),
        activationStart: nonnegative,
        responseStart: nonnegative,
        responseEnd: nonnegative,
        domContentLoadedEventEnd: nonnegative,
        loadEventEnd: nonnegative,
      })
      .strict()
      .nullable(),
    paints: z
      .array(z.object({ name: short(60), startTime: nonnegative }).strict())
      .max(10),
    lcp: z
      .array(
        z
          .object({
            startTime: nonnegative,
            size: nonnegative,
            element: description,
          })
          .strict(),
      )
      .max(CAP),
    shifts: z
      .array(
        z
          .object({
            startTime: nonnegative,
            value: nonnegative,
            hadRecentInput: z.boolean(),
          })
          .strict(),
      )
      .max(CAP),
    // Event Timing entries of interactions (interactionId > 0) over 16 ms.
    events: z
      .array(
        z
          .object({
            name: short(40),
            startTime: nonnegative,
            duration: nonnegative,
            processingStart: nonnegative,
            processingEnd: nonnegative,
            interactionId: z.number().int().positive(),
            target: description,
            // Indices of the interactionTargets the target is inside.
            matches: z.array(z.number().int().nonnegative()).max(20),
          })
          .strict(),
      )
      .max(CAP),
    // Every trusted pointerdown and keydown, including those too fast for
    // Event Timing to report: the number of interactions.
    inputs: z
      .array(
        z
          .object({
            type: short(40),
            at: time,
            target: description,
            matches: z.array(z.number().int().nonnegative()).max(20),
          })
          .strict(),
      )
      .max(CAP),
    longTasks: z
      .array(
        z.object({ startTime: nonnegative, duration: nonnegative }).strict(),
      )
      .max(CAP),
    dropped: z.number().int().nonnegative(),
    errors: z.array(short(300)).max(20),
  })
  .strict();
export type RawPerformance = z.infer<typeof rawPerformanceSchema>;

// The entry type each metric needs from PerformanceObserver.
const ENTRY_TYPE: Record<PerformanceMetric, string> = {
  ttfbMs: 'navigation',
  fcpMs: 'paint',
  lcpMs: 'largest-contentful-paint',
  cls: 'layout-shift',
  inpMs: 'event',
  domContentLoadedMs: 'navigation',
  loadMs: 'navigation',
  blockingTimeMs: 'longtask',
};

const LABEL: Record<PerformanceMetric, string> = {
  ttfbMs: 'Time to first byte',
  fcpMs: 'First contentful paint',
  lcpMs: 'Largest contentful paint',
  cls: 'Cumulative layout shift',
  inpMs: 'Interaction to next paint',
  domContentLoadedMs: 'DOMContentLoaded',
  loadMs: 'Load event',
  blockingTimeMs: 'Blocking time',
};

const HELP: Record<PerformanceMetric, string> = {
  ttfbMs: 'https://web.dev/articles/ttfb',
  fcpMs: 'https://web.dev/articles/fcp',
  lcpMs: 'https://web.dev/articles/lcp',
  cls: 'https://web.dev/articles/cls',
  inpMs: 'https://web.dev/articles/inp',
  domContentLoadedMs:
    'https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming/domContentLoadedEventEnd',
  loadMs:
    'https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming/loadEventEnd',
  blockingTimeMs: 'https://web.dev/articles/tbt',
};

// Event Timing reports interactions of at least this duration only.
export const EVENT_TIMING_THRESHOLD_MS = 16;
// A main-thread task over this is a long task; the excess is blocking time.
const LONG_TASK_MS = 50;
// Paints and shifts land a frame or two after the call that caused them.
const HARNESS_TAIL_MS = 100;

// ------------------------------------------------------------ computation

// Wall-clock (epoch ms) intervals when another audit ran in the page.
export type HarnessInterval = { start: number; end: number };

// The largest burst of layout shifts: shifts less than 1 s apart, a burst
// at most 5 s long, shifts right after input left out (web.dev/articles/cls).
export function cumulativeLayoutShift(
  shifts: { startTime: number; value: number }[],
): number {
  let max = 0;
  let current = 0;
  let first = 0;
  let last = 0;
  for (const shift of [...shifts].sort((a, b) => a.startTime - b.startTime)) {
    if (
      current > 0 &&
      shift.startTime - last < 1000 &&
      shift.startTime - first < 5000
    ) {
      current += shift.value;
      last = shift.startTime;
    } else {
      current = shift.value;
      first = last = shift.startTime;
    }
    max = Math.max(max, current);
  }
  return Math.round(max * 10000) / 10000;
}

// Interaction to next paint over `durations` (one per interaction): the
// slowest one, ignoring one in every 50 interactions (the 98th percentile).
// Interactions too fast for Event Timing are passed as null: they are below
// the threshold. Null when the selected value is one of those, or none.
export function interactionToNextPaint(
  durations: (number | null)[],
): number | null {
  if (!durations.length) return null;
  const sorted = [...durations].sort(
    (a, b) => (b ?? -1) - (a ?? -1),
  );
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))]!;
}

const round = (value: number) => Math.round(value * 10) / 10;

function conditionsText(conditions: PerformanceConditionsRecord): string {
  const parts: string[] = [];
  if (conditions.network)
    parts.push(
      `network ${conditions.networkProfile ?? 'custom'} (${conditions.network.latencyMs} ms latency, ${conditions.network.downloadKbps} kbps down)`,
    );
  if (conditions.cpuSlowdown !== null)
    parts.push(`CPU ${conditions.cpuSlowdown}x slower`);
  return parts.length ? parts.join(', ') : 'no throttling';
}

const show = (metric: PerformanceMetric, value: number): string =>
  metric === 'cls' ? String(value) : `${Math.round(value)} ms`;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export type PerformanceContext = {
  config: PerformanceAuditConfig;
  browser: string;
  conditions: PerformanceConditionsRecord;
  // Other audits' page work, in wall-clock (epoch) ms.
  harnessIntervals: HarnessInterval[];
  harness: HarnessTiming | null;
  // Set when the load event had not fired within this many ms of waiting.
  loadWaitedMs: number | null;
};

export function performanceMeasurement(
  raw: RawPerformance,
  context: PerformanceContext,
): PerformanceMeasurement {
  const supported = new Set(raw.supported);
  const unsupported = PERFORMANCE_METRICS.filter(
    (metric) => !supported.has(ENTRY_TYPE[metric]),
  );
  const has = (metric: PerformanceMetric) => !unsupported.includes(metric);
  const epoch = (at: number) => raw.timeOrigin + at;
  const during = (at: number) =>
    context.harnessIntervals.some(
      (interval) =>
        epoch(at) >= interval.start &&
        epoch(at) <= interval.end + HARNESS_TAIL_MS,
    );
  const overlaps = (start: number, duration: number) =>
    context.harnessIntervals.some(
      (interval) =>
        epoch(start) <= interval.end + HARNESS_TAIL_MS &&
        epoch(start + duration) >= interval.start,
    );
  const nav = raw.navigation;
  const since = (at: number) =>
    round(Math.max(0, at - (nav?.activationStart ?? 0)));
  const navigationMetric = (at: number | undefined) =>
    has('ttfbMs') && nav && at && at > 0 ? since(at) : null;

  // Layout shifts and LCP candidates.
  const shifts = raw.shifts.filter((shift) => !shift.hadRecentInput);
  const appShifts = shifts.filter((shift) => !during(shift.startTime));
  const appLcp = raw.lcp.filter((entry) => !during(entry.startTime));
  const lcp = appLcp.at(-1) ?? null;
  const fcp = raw.paints.find((paint) => paint.name === 'first-contentful-paint');

  // Interactions: one per interactionId, its longest entry.
  const targets = context.config.interactionTargets;
  const selectedBy = (matches: number[]) =>
    !targets.length || matches.length > 0;
  const groups = new Map<number, RawPerformance['events']>();
  let excludedInteractions = 0;
  for (const event of raw.events) {
    const group = groups.get(event.interactionId) ?? [];
    group.push(event);
    groups.set(event.interactionId, group);
  }
  const measured: PerformanceInteraction[] = [];
  for (const group of groups.values()) {
    // The interaction's duration is its longest entry's; its phases span
    // all of its entries (pointerdown, pointerup, click ...).
    const longest = group.reduce((a, b) => (b.duration > a.duration ? b : a));
    const start = Math.min(...group.map((event) => event.startTime));
    const processingStart = Math.min(
      ...group.map((event) => event.processingStart),
    );
    const processingEnd = Math.max(
      ...group.map((event) => event.processingEnd),
    );
    if (during(start)) {
      excludedInteractions++;
      continue;
    }
    measured.push({
      type: longest.name,
      target: group.find((event) => event.target)?.target ?? null,
      selected: group.some((event) => selectedBy(event.matches)),
      durationMs: longest.duration,
      inputDelayMs: round(Math.max(0, processingStart - start)),
      processingMs: round(Math.max(0, processingEnd - processingStart)),
      presentationMs: round(
        Math.max(0, longest.startTime + longest.duration - processingEnd),
      ),
      atMs: since(start),
    });
  }
  // Inputs Event Timing did not report were faster than its threshold.
  const inputs = raw.inputs.filter((input) => !during(input.at));
  const selectedInputs = inputs.filter((input) => selectedBy(input.matches));
  const selectedMeasured = measured.filter((entry) => entry.selected);
  const fast = Math.max(0, selectedInputs.length - selectedMeasured.length);
  const inp = has('inpMs')
    ? interactionToNextPaint([
        ...selectedMeasured.map((entry) => entry.durationMs),
        ...Array<null>(fast).fill(null),
      ])
    : null;

  // Long tasks.
  const tasks = { app: { count: 0, blockingMs: 0 }, duringHarness: { count: 0, blockingMs: 0 } };
  for (const task of raw.longTasks) {
    const side = overlaps(task.startTime, task.duration)
      ? tasks.duringHarness
      : tasks.app;
    side.count++;
    side.blockingMs = round(
      side.blockingMs + Math.max(0, task.duration - LONG_TASK_MS),
    );
  }

  const metrics: PerformanceMeasurement['metrics'] = {
    ttfbMs: navigationMetric(nav?.responseStart),
    fcpMs: has('fcpMs') && fcp ? since(fcp.startTime) : null,
    lcpMs: has('lcpMs') && lcp ? since(lcp.startTime) : null,
    cls: has('cls') ? cumulativeLayoutShift(appShifts) : null,
    inpMs: inp,
    domContentLoadedMs: navigationMetric(nav?.domContentLoadedEventEnd),
    loadMs: navigationMetric(nav?.loadEventEnd),
    blockingTimeMs: has('blockingTimeMs') ? tasks.app.blockingMs : null,
  };

  const budgets: BudgetResult[] = context.config.budgets.map((budget) => {
    const value = metrics[budget.metric];
    const status: BudgetResult['status'] = !has(budget.metric)
      ? 'unsupported'
      : value === null
        ? // Every selected interaction was under Event Timing's threshold:
          // below any budget at or above it.
          budget.metric === 'inpMs' &&
          selectedInputs.length > 0 &&
          budget.max >= EVENT_TIMING_THRESHOLD_MS
          ? 'within'
          : 'not_measured'
        : value > budget.max
          ? 'exceeded'
          : 'within';
    return { ...budget, value, status };
  });

  return {
    document: {
      path: pathOf(raw.url),
      navigationType: nav?.type || null,
      ageMs: round(raw.now),
    },
    conditions: context.conditions,
    browser: context.browser,
    unsupported,
    metrics,
    lcpElement: lcp?.element ?? null,
    interactions: {
      count: inputs.length,
      selected: selectedInputs.length,
      slowest: [...measured]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10),
    },
    longTasks: tasks,
    excludedDuringHarness: {
      layoutShifts: shifts.length - appShifts.length,
      lcpCandidates: raw.lcp.length - appLcp.length,
      interactions: excludedInteractions,
    },
    dropped: raw.dropped,
    harness: context.harness,
    budgets,
  };
}

// The audit output for one measurement: a violation per exceeded budget.
export function performanceOutput(
  raw: RawPerformance,
  context: PerformanceContext,
): AuditOutput {
  const measurement = performanceMeasurement(raw, context);
  const limitations: string[] = [
    'Metrics describe the current document only: client-side (soft) navigations are not separated, and browsers stop reporting LCP at the first input or scroll',
    'One measurement under the session conditions; timings vary between runs, so compare repeated runs (--repeat) with the same conditions rather than single values',
    'Model calls, screenshots and waits are not in the metrics (browser timestamps); entries recorded while another audit ran in the page are counted separately by timestamp overlap and left out',
  ];
  if (!context.config.budgets.length)
    limitations.push(
      'No budgets configured: measurements only, never a finding or a gate',
    );
  if (measurement.unsupported.length)
    limitations.push(
      `${context.browser} does not report ${measurement.unsupported.join(', ')}; those metrics are null, not 0`,
    );
  if (context.conditions.network)
    limitations.push(
      "Chromium adds emulated network latency when the response body arrives, not to the first byte: ttfbMs does not include it; fcpMs, lcpMs and loadMs do",
    );
  if (context.conditions.cpuSlowdown !== null)
    limitations.push(
      'CPU slowdown applies to the whole session, the harness’s own page scripts included',
    );
  if (context.loadWaitedMs !== null)
    limitations.push(
      `The load event had not fired after waiting ${context.loadWaitedMs} ms; loadMs is null`,
    );
  const interactions = measurement.interactions;
  if (
    interactions.selected > 0 &&
    measurement.metrics.inpMs === null &&
    !measurement.unsupported.includes('inpMs')
  )
    limitations.push(
      `inpMs is under ${EVENT_TIMING_THRESHOLD_MS} ms: Event Timing reports only slower interactions`,
    );
  if (measurement.dropped)
    limitations.push(
      `${measurement.dropped} performance entries past the collector's cap were not measured`,
    );
  for (const budget of measurement.budgets)
    if (budget.status === 'not_measured')
      limitations.push(
        `Budget on ${budget.metric} not evaluated: the page produced no value at this checkpoint`,
      );
  const unsupportedBudgets = measurement.budgets.filter(
    (budget) => budget.status === 'unsupported',
  );
  const findings: AuditOutputFinding[] = measurement.budgets
    .filter((budget) => budget.status === 'exceeded')
    .map((budget) => {
      const reason =
        budget.metric === 'lcpMs'
          ? measurement.lcpElement
            ? `Largest contentful paint: ${measurement.lcpElement}`
            : null
          : budget.metric === 'inpMs'
            ? (interactions.slowest.find((entry) => entry.selected)?.target ??
              null)
            : null;
      return {
        ruleId: `performance-budget.${budget.metric}`,
        severity: budget.severity,
        certainty: 'violation' as const,
        description: `${LABEL[budget.metric]} ${show(budget.metric, budget.value!)} exceeds the suite budget of ${show(budget.metric, budget.max)} (${conditionsText(context.conditions)}, ${context.browser})`,
        helpUrl: HELP[budget.metric],
        tags: ['performance', budget.metric],
        nodeCount: 1,
        targets: [
          {
            description: `document ${measurement.document.path || '/'}`,
            selector: null,
            reason: reason ? reason.slice(0, 2000) : null,
            snippet: null,
          },
        ],
      };
    });
  const errors = raw.errors.length
    ? `The collector could not observe ${raw.errors.join('; ')}`
    : null;
  const notInstalled = raw.installed
    ? null
    : 'The measurement script did not run in this document, so it was not measured';
  return {
    complete: !unsupportedBudgets.length && !errors && !notInstalled,
    detail:
      notInstalled ??
      errors ??
      (unsupportedBudgets.length
        ? `${context.browser} does not report ${unsupportedBudgets.map((budget) => budget.metric).join(', ')}, so ${unsupportedBudgets.length === 1 ? 'its budget' : 'their budgets'} could not be evaluated`
        : null),
    analyzer: { name: 'performance-timeline', version: null },
    limitations: limitations.slice(0, 20),
    findings: notInstalled ? [] : findings,
    performance: notInstalled ? null : measurement,
  };
}

// The record of the configured conditions, before the driver applies them.
export function conditionsRecord(
  config: PerformanceAuditConfig,
  applied: boolean,
): PerformanceConditionsRecord {
  const network = config.conditions?.network;
  return {
    networkProfile:
      network === undefined
        ? null
        : typeof network === 'string'
          ? network
          : 'custom',
    network:
      network === undefined
        ? null
        : typeof network === 'string'
          ? { ...NETWORK_PRESETS[network] }
          : { ...network },
    cpuSlowdown: config.conditions?.cpuSlowdown ?? null,
    applied,
  };
}

export const performanceWebAudit: AuditDefinition<PerformanceAuditConfig> = {
  id: 'performance.web',
  source: 'builtin',
  title: 'Navigation timing and Web Vitals',
  drivers: ['playwright'],
  unsupported:
    'The macOS accessibility driver has no web performance timeline to read',
};
