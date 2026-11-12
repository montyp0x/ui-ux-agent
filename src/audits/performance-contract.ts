// The performance.web contract: its suite configuration (controlled
// conditions, optional budgets) and the measurement an audit run records.
// Kept apart from src/audits/performance.ts so contract.ts and config.ts can
// import it without the computation.
//
// Every value is measured by the browser in the page under test; nothing is
// estimated or filled in. A metric the browser does not report is null and
// named in `unsupported`, never 0.
import { z } from 'zod';

// contract.ts imports this file, so its severity scale (axe-core's impact
// scale, least severe first) is repeated here rather than imported.
const severitySchema = z.enum(['minor', 'moderate', 'serious', 'critical']);

// --------------------------------------------------------------- metrics

// Milliseconds from the document's navigation start, except cls (unitless)
// and blockingTimeMs (a sum of long-task time over 50 ms).
export const PERFORMANCE_METRICS = [
  'ttfbMs',
  'fcpMs',
  'lcpMs',
  'cls',
  'inpMs',
  'domContentLoadedMs',
  'loadMs',
  'blockingTimeMs',
] as const;
export const performanceMetricSchema = z.enum(PERFORMANCE_METRICS);
export type PerformanceMetric = z.infer<typeof performanceMetricSchema>;

// ------------------------------------------------------------ conditions

const network = z
  .object({
    // Added round-trip latency.
    latencyMs: z.number().int().min(0).max(10000),
    downloadKbps: z.number().positive().max(1000000),
    uploadKbps: z.number().positive().max(1000000),
  })
  .strict();
export type NetworkConditions = z.infer<typeof network>;

// Named profiles resolve to these values; the result records the values.
export const NETWORK_PRESETS = {
  'slow-3g': { latencyMs: 400, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
} as const satisfies Record<string, NetworkConditions>;

export const performanceConditionsSchema = z
  .object({
    network: z
      .union([
        z.enum(
          Object.keys(NETWORK_PRESETS) as [keyof typeof NETWORK_PRESETS],
        ),
        network,
      ])
      .optional(),
    // CPU slowdown factor (Chromium's CPU throttling rate): 4 runs page
    // script about four times slower.
    cpuSlowdown: z.number().min(1).max(20).optional(),
  })
  .strict()
  .refine(
    (conditions) =>
      conditions.network !== undefined || conditions.cpuSlowdown !== undefined,
    'Set network, cpuSlowdown or both (omit conditions to measure unthrottled)',
  );
export type PerformanceConditions = z.infer<typeof performanceConditionsSchema>;

// ---------------------------------------------------------------- budgets

// A suite-owned limit on one metric. A measured value above `max` is a
// violation at the budget's own severity, gated by audits.failOn like any
// audit finding. There is no default severity and no default budget.
export const performanceBudgetSchema = z
  .object({
    metric: performanceMetricSchema,
    max: z.number().nonnegative().max(600000),
    severity: severitySchema,
  })
  .strict();
export type PerformanceBudget = z.infer<typeof performanceBudgetSchema>;

const css = z.string().min(1).max(200);

// The options of the performance.web audit entry (src/audits/config.ts).
export const performanceAuditConfigShape = {
  // Applied by the web driver to the whole session, before the first
  // navigation (Chromium only). Omitted: the session runs unthrottled.
  conditions: performanceConditionsSchema.optional(),
  budgets: z
    .array(performanceBudgetSchema)
    .max(PERFORMANCE_METRICS.length)
    .default([])
    .refine(
      (budgets) =>
        new Set(budgets.map((budget) => budget.metric)).size === budgets.length,
      'Each metric can have one budget',
    ),
  // CSS selectors of the controls whose interactions count for inpMs (an
  // interaction counts when its target is inside a match). Empty: every
  // interaction in the document counts.
  interactionTargets: z.array(css).max(20).default([]),
};

// ----------------------------------------------------------- measurement

const ms = z.number().nonnegative();
const count = z.number().int().nonnegative();
const nullableMs = ms.nullable();

export const performanceConditionsRecordSchema = z
  .object({
    // The network profile name, custom, or null when not throttled.
    networkProfile: z.string().min(1).nullable(),
    network: network.nullable(),
    cpuSlowdown: z.number().min(1).nullable(),
    // Whether the driver applied the conditions to this session. False with
    // conditions configured never yields a measurement.
    applied: z.boolean(),
  })
  .strict();
export type PerformanceConditionsRecord = z.infer<
  typeof performanceConditionsRecordSchema
>;

const interactionSchema = z
  .object({
    // The event of the interaction's longest entry (click, keydown ...).
    type: z.string().min(1).max(40),
    // tag#id.class of the event target, or null when it was gone.
    target: z.string().min(1).max(200).nullable(),
    // Whether it counts for inpMs under interactionTargets.
    selected: z.boolean(),
    // From the input to the next paint after the handlers ran.
    durationMs: ms,
    inputDelayMs: ms,
    processingMs: ms,
    presentationMs: ms,
    // When the input happened, from navigation start.
    atMs: ms,
  })
  .strict();
export type PerformanceInteraction = z.infer<typeof interactionSchema>;

const blocking = z.object({ count, blockingMs: ms }).strict();

export const budgetResultSchema = z
  .object({
    metric: performanceMetricSchema,
    max: ms,
    severity: severitySchema,
    value: z.number().nonnegative().nullable(),
    // within: measured, at or below max. exceeded: measured above max (a
    // violation). not_measured: the page produced no value yet (no
    // interaction, no load event). unsupported: the browser does not report
    // the metric; the run is incomplete.
    status: z.enum(['within', 'exceeded', 'not_measured', 'unsupported']),
  })
  .strict();
export type BudgetResult = z.infer<typeof budgetResultSchema>;

// Harness work over the journey up to this checkpoint. It is never part of
// the app metrics above, which come from the browser's own timestamps.
export const harnessTimingSchema = z
  .object({
    // Wall-clock time since the journey started.
    elapsedMs: ms,
    // Planner and selector calls (latency as the runner measured it).
    modelCalls: count,
    modelMs: ms,
    // Evidence screenshots the web driver took, and their capture time.
    screenshots: count,
    screenshotMs: ms,
    // Earlier audit runs (this one excluded).
    auditMs: ms,
  })
  .strict();
export type HarnessTiming = z.infer<typeof harnessTimingSchema>;

export const performanceMeasurementSchema = z
  .object({
    document: z
      .object({
        // Path of the measured document (no origin, query or fragment).
        path: z.string(),
        // navigate, reload, back_forward ... (null when not reported).
        navigationType: z.string().min(1).max(40).nullable(),
        // Time from the document's navigation start to this measurement:
        // mostly harness time (model calls, screenshots, audits) in a run.
        ageMs: ms,
      })
      .strict(),
    conditions: performanceConditionsRecordSchema,
    browser: z.string().min(1),
    // Metrics this browser does not report (null below, never 0).
    unsupported: z.array(performanceMetricSchema),
    metrics: z
      .object({
        ttfbMs: nullableMs,
        fcpMs: nullableMs,
        lcpMs: nullableMs,
        cls: z.number().nonnegative().nullable(),
        inpMs: nullableMs,
        domContentLoadedMs: nullableMs,
        loadMs: nullableMs,
        blockingTimeMs: nullableMs,
      })
      .strict(),
    // tag#id.class of the largest contentful paint's element.
    lcpElement: z.string().min(1).max(200).nullable(),
    interactions: z
      .object({
        count,
        selected: count,
        // The slowest interactions, slowest first.
        slowest: z.array(interactionSchema).max(10),
      })
      .strict(),
    // Long tasks (main-thread tasks over 50 ms) of the app, and those that
    // overlapped another audit running in the page (axe-core scans,
    // breakpoint sweeps, visual captures), which are left out of
    // blockingTimeMs.
    longTasks: z
      .object({ app: blocking, duringHarness: blocking })
      .strict(),
    // Layout shifts, LCP candidates and interactions recorded while another
    // audit ran in the page, left out of cls, lcpMs and inpMs.
    excludedDuringHarness: z
      .object({
        layoutShifts: count,
        lcpCandidates: count,
        interactions: count,
      })
      .strict(),
    // Entries past the collector's per-type cap (not measured).
    dropped: count,
    harness: harnessTimingSchema.nullable(),
    budgets: z.array(budgetResultSchema),
  })
  .strict();
export type PerformanceMeasurement = z.infer<
  typeof performanceMeasurementSchema
>;
