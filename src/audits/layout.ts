// Responsive layout audit: configuration, the breakpoint matrix and the typed
// result contract. Measurement runs in the page (layout-detect.ts) and is
// driven by a browser driver (drivers/playwright-layout.ts); nothing here
// depends on a browser implementation.
import { z } from 'zod';
import { targetSchema, type Suite } from '../contracts.js';

export const LAYOUT_RULES = ['clipping', 'occlusion', 'target-size'] as const;
export const layoutRuleSchema = z.enum(LAYOUT_RULES);
export type LayoutRule = z.infer<typeof layoutRuleSchema>;

const breakpointName = z.string().regex(/^[a-z0-9-]+$/);

// An intentional layout the detectors must not report, scoped to one rule and
// one selector (and optionally to named breakpoints). The selector matches the
// reported element or one of its ancestors; for occlusion it may also match
// the covering element (e.g. decorative hero art). Every use is listed in the
// result next to the measurement it suppressed.
export const layoutExceptionSchema = z
  .object({
    rule: layoutRuleSchema,
    selector: z.string().min(1).max(500),
    reason: z.string().min(1).max(500),
    breakpoints: z.array(breakpointName).min(1).optional(),
  })
  .strict();
export type LayoutException = z.infer<typeof layoutExceptionSchema>;

export const layoutAuditConfigSchema = z
  .object({
    rules: z
      .array(layoutRuleSchema)
      .min(1)
      .default([...LAYOUT_RULES]),
    // Controls that must stay operable. Without any, occlusion checks every
    // rendered interactive control outside an open modal.
    requiredControls: z.array(targetSchema).max(50).default([]),
    clipping: z
      .object({
        // Sub-pixel rounding allowance before content counts as cut off.
        tolerancePx: z.number().min(0).max(16).default(1),
      })
      .strict()
      .prefault({}),
    occlusion: z
      .object({
        // Share of the 3x3 hit-test samples another element must cover for a
        // finding when the centre is uncovered. Smaller overlaps are review
        // candidates.
        minCoveredFraction: z.number().gt(0).max(1).default(0.3),
      })
      .strict()
      .prefault({}),
    targetSize: z
      .object({
        // WCAG 2.2 SC 2.5.8 (AA) is 24 CSS px; 2.5.5 (AAA) is 44.
        minimum: z.number().int().min(16).max(96).default(24),
        // The 2.5.8 spacing exception (a circle of `minimum` diameter around
        // an undersized target touches no other target). 2.5.5 has none, so
        // it defaults to on only for minimums up to 24.
        spacingExemption: z.boolean().optional(),
      })
      .strict()
      .prefault({}),
    exceptions: z.array(layoutExceptionSchema).max(50).default([]),
  })
  .strict();
export type LayoutAuditConfig = z.infer<typeof layoutAuditConfigSchema>;
export type LayoutAuditConfigInput = z.input<typeof layoutAuditConfigSchema>;

// The same shape as a suite viewport, with a wider lower bound so derived
// reflow cases fit, and an optional device pixel ratio.
export const breakpointSchema = z
  .object({
    name: breakpointName,
    width: z.number().int().min(160).max(3840),
    height: z.number().int().min(120).max(2160),
    deviceScaleFactor: z.number().min(1).max(4).optional(),
  })
  .strict();
export type Breakpoint = z.infer<typeof breakpointSchema>;

export const layoutMatrixSchema = z
  .object({
    // Defaults to the suite's viewports.
    breakpoints: z.array(breakpointSchema).min(1).max(12).optional(),
    // Reflow at browser zoom, expressed as the CSS viewport the zoom produces:
    // 1280x1024 at 400% lays out like a 320x256 viewport (WCAG 2.2 SC 1.4.10).
    reflow: z
      .union([
        z.literal(false),
        z
          .object({
            baseWidth: z.number().int().min(320).max(3840).default(1280),
            baseHeight: z.number().int().min(240).max(2160).default(1024),
            zoom: z.number().min(1.25).max(8).default(4),
          })
          .strict(),
      ])
      .prefault({}),
  })
  .strict();
export type LayoutMatrix = z.infer<typeof layoutMatrixSchema>;
export type LayoutMatrixInput = z.input<typeof layoutMatrixSchema>;

export const layoutBreakpointSchema = z
  .object({
    name: breakpointName,
    width: z.number().int(),
    height: z.number().int(),
    deviceScaleFactor: z.number(),
    kind: z.enum(['viewport', 'reflow']),
    // Browser zoom the case stands for; null for declared viewports.
    zoom: z.number().nullable(),
  })
  .strict();
export type LayoutBreakpoint = z.infer<typeof layoutBreakpointSchema>;

// Declared widths plus the reflow case, in a stable order.
export function expandBreakpoints(
  matrix: LayoutMatrixInput,
  viewports: Suite['viewports'] = [],
): LayoutBreakpoint[] {
  const parsed = layoutMatrixSchema.parse(matrix);
  const declared = parsed.breakpoints ?? viewports;
  if (!declared.length)
    throw new Error('A layout matrix needs breakpoints or suite viewports');
  const cases: LayoutBreakpoint[] = declared.map(
    (viewport: Breakpoint): LayoutBreakpoint => ({
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      kind: 'viewport',
      zoom: null,
    }),
  );
  if (parsed.reflow) {
    const { baseWidth, baseHeight, zoom } = parsed.reflow;
    // Bounds-checked like a declared breakpoint.
    const reflow = breakpointSchema.parse({
      name: `reflow-${Math.round(zoom * 100)}`,
      width: Math.round(baseWidth / zoom),
      height: Math.round(baseHeight / zoom),
    });
    cases.push({ ...reflow, deviceScaleFactor: 1, kind: 'reflow', zoom });
  }
  const names = cases.map((entry) => entry.name);
  if (new Set(names).size !== names.length)
    throw new Error(`Breakpoint names must be unique: ${names.join(', ')}`);
  return cases;
}

// ---- Result contract ----

const boxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type Box = z.infer<typeof boxSchema>;

const clippedItemSchema = z
  .object({
    selector: z.string(),
    kind: z.enum(['text', 'control']),
    excerpt: z.string(),
    box: boxSchema,
    // CSS px of the item outside the container's clip box, per edge.
    cut: z
      .object({
        left: z.number(),
        right: z.number(),
        top: z.number(),
        bottom: z.number(),
      })
      .strict(),
    visibleFraction: z.number().min(0).max(1),
  })
  .strict();

const clippingFindingSchema = z
  .object({
    rule: z.literal('clipping'),
    selector: z.string(),
    box: boxSchema,
    clipBox: boxSchema,
    overflowX: z.string(),
    overflowY: z.string(),
    items: z.array(clippedItemSchema),
    itemsTotal: z.number().int(),
    maxCutPx: z.number(),
    description: z.string(),
  })
  .strict();

const occlusionFindingSchema = z
  .object({
    rule: z.literal('occlusion'),
    selector: z.string(),
    name: z.string(),
    box: boxSchema,
    required: z.boolean(),
    // The element hit instead of the control, and its nearest positioned
    // ancestor (the covering layer, e.g. a fixed banner).
    cover: z
      .object({ selector: z.string(), layer: z.string(), box: boxSchema })
      .strict(),
    samples: z.number().int(),
    covered: z.number().int(),
    coveredFraction: z.number().min(0).max(1),
    centerCovered: z.boolean(),
    description: z.string(),
  })
  .strict();

const targetSizeFindingSchema = z
  .object({
    rule: z.literal('target-size'),
    selector: z.string(),
    name: z.string(),
    box: boxSchema,
    width: z.number(),
    height: z.number(),
    minimum: z.number(),
    description: z.string(),
  })
  .strict();

export const layoutFindingSchema = z.discriminatedUnion('rule', [
  clippingFindingSchema,
  occlusionFindingSchema,
  targetSizeFindingSchema,
]);
export type LayoutFinding = z.infer<typeof layoutFindingSchema>;

const exemptedSchema = z
  .object({
    rule: layoutRuleSchema,
    selector: z.string(),
    exemption: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('exception'),
          index: z.number().int(),
          selector: z.string(),
          reason: z.string(),
          matchedOn: z.enum(['subject', 'container', 'cover']),
        })
        .strict(),
      // Built-in WCAG 2.5.8 exceptions, reported so they stay reviewable.
      z
        .object({
          kind: z.enum(['inline', 'spacing', 'equivalent-label']),
          detail: z.string(),
        })
        .strict(),
    ]),
    // The finding this exemption suppressed, as it would have been reported.
    measured: layoutFindingSchema,
  })
  .strict();
export type LayoutExempted = z.infer<typeof exemptedSchema>;

// Inference-heavy signals (declared truncation, small overlaps): for review,
// never findings and never part of the status.
const reviewCandidateSchema = z
  .object({
    rule: layoutRuleSchema,
    kind: z.enum(['truncation-ellipsis', 'line-clamp', 'partial-occlusion']),
    selector: z.string(),
    box: boxSchema,
    detail: z.string(),
  })
  .strict();
export type LayoutReviewCandidate = z.infer<typeof reviewCandidateSchema>;

export const layoutStatusSchema = z.enum([
  'clean',
  'findings',
  'incomplete',
  'unsupported',
  'error',
]);
export type LayoutStatus = z.infer<typeof layoutStatusSchema>;

export const layoutDetectorResultSchema = z
  .object({
    rule: layoutRuleSchema,
    status: layoutStatusSchema,
    // Elements or text runs measured; zero checked is not evidence of health.
    checked: z.number().int(),
    skipped: z.record(z.string(), z.number().int()),
    findings: z.array(layoutFindingSchema),
    exempted: z.array(exemptedSchema),
    reviewCandidates: z.array(reviewCandidateSchema),
    incomplete: z.array(z.string()),
    truncated: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type LayoutDetectorResult = z.infer<typeof layoutDetectorResultSchema>;

const exceptionLedgerSchema = z
  .object({
    index: z.number().int(),
    rule: layoutRuleSchema,
    selector: z.string(),
    reason: z.string(),
    // False when scoped to other breakpoints.
    active: z.boolean(),
    // Times it suppressed a measurement in this audit.
    uses: z.number().int(),
  })
  .strict();

export const layoutAuditResultSchema = z
  .object({
    version: z.literal(1),
    status: layoutStatusSchema,
    url: z.string(),
    breakpoint: layoutBreakpointSchema.nullable(),
    viewport: z
      .object({
        width: z.number(),
        height: z.number(),
        devicePixelRatio: z.number(),
      })
      .strict()
      .nullable(),
    detectors: z.array(layoutDetectorResultSchema),
    exceptions: z.array(exceptionLedgerSchema),
    // Why the whole audit is unsupported or failed; null otherwise.
    detail: z.string().nullable(),
  })
  .strict();
export type LayoutAuditResult = z.infer<typeof layoutAuditResultSchema>;

const STATUS_ORDER: LayoutStatus[] = [
  'clean',
  'incomplete',
  'findings',
  'unsupported',
  'error',
];

// The worst status wins: an error is never reported as clean, and findings
// outrank incomplete coverage.
export function combineStatus(statuses: LayoutStatus[]): LayoutStatus {
  if (!statuses.length) return 'incomplete';
  return statuses.reduce((worst, status) =>
    STATUS_ORDER.indexOf(status) > STATUS_ORDER.indexOf(worst) ? status : worst,
  );
}

export function detectorStatus(
  detector: Pick<LayoutDetectorResult, 'error' | 'findings' | 'incomplete'>,
): LayoutStatus {
  if (detector.error !== null) return 'error';
  if (detector.findings.length) return 'findings';
  if (detector.incomplete.length) return 'incomplete';
  return 'clean';
}

// Exceptions in force at a breakpoint, keeping their configured index.
export function activeExceptions(
  exceptions: LayoutException[],
  breakpoint: Pick<LayoutBreakpoint, 'name'> | null,
): (LayoutException & { index: number })[] {
  return exceptions
    .map((exception, index) => ({ ...exception, index }))
    .filter(
      (exception) =>
        !exception.breakpoints ||
        (breakpoint !== null &&
          exception.breakpoints.includes(breakpoint.name)),
    );
}

// A result for audits that could not measure: every configured rule carries
// the same status and reason, so nothing reads as clean.
export function unmeasuredResult(
  status: 'error' | 'unsupported',
  detail: string,
  config: LayoutAuditConfig,
  breakpoint: LayoutBreakpoint | null,
  url = '',
): LayoutAuditResult {
  return {
    version: 1,
    status,
    url,
    breakpoint,
    viewport: null,
    detectors: config.rules.map((rule) => ({
      rule,
      status,
      checked: 0,
      skipped: {},
      findings: [],
      exempted: [],
      reviewCandidates: [],
      incomplete: [],
      truncated: false,
      error: status === 'error' ? detail : null,
    })),
    exceptions: config.exceptions.map((exception, index) => ({
      index,
      rule: exception.rule,
      selector: exception.selector,
      reason: exception.reason,
      active: activeExceptions(config.exceptions, breakpoint).some(
        (active) => active.index === index,
      ),
      uses: 0,
    })),
    detail,
  };
}
