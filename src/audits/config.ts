// Suite configuration for audits: which audits run, at which checkpoints, and
// which finding severity fails the quality verdict. Audits run only at the
// checkpoints listed here, never after every action.
import { z } from 'zod';
import { failOnSchema } from './contract.js';
import { layoutAuditConfigSchema, layoutMatrixSchema } from './layout.js';
import { visualAuditConfigShape } from './visual.js';

// Where an audit runs: ready (first state after ready and setup), states
// (each of the journey's declared `states`, once, when it first holds) and
// completion (the final state when the journey ends).
export const auditAtSchema = z
  .array(z.enum(['ready', 'states', 'completion']))
  .min(1)
  .max(3)
  .refine(
    (at) => new Set(at).size === at.length,
    'Audit checkpoints must be unique',
  );
export type AuditAt = z.infer<typeof auditAtSchema>[number];

// Fields every audit entry has; spread into each member.
export const auditCheckFields = {
  // Overrides audits.timeoutMs for this audit's runs.
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
};

// One entry per audit. Audits with options add their own member; the id is
// the discriminator, so an unknown audit is a configuration error.
const horizontalOverflowConfig = z
  .object({
    ...auditCheckFields,
    id: z.literal('layout.horizontal-overflow'),
    // Reads every state observed since its previous checkpoint, so the
    // default single completion run covers the whole journey.
    at: auditAtSchema.default(['completion']),
  })
  .strict();

// axe-core rule tags (wcag2a, best-practice, cat.forms ...): letters,
// digits, dots and dashes only.
const axeTag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/);
// WCAG 2.x level A and AA rules plus axe's best-practice rules.
export const DEFAULT_AXE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
];
const cssScope = z.array(z.string().min(1).max(200)).max(20).default([]);
// An automated axe-core scan of the page in the web driver. Partial by nature:
// it never establishes WCAG conformance (see src/audits/accessibility.ts).
const axeConfig = z
  .object({
    ...auditCheckFields,
    id: z.literal('accessibility.axe'),
    // The first ready state and the final state.
    at: auditAtSchema.default(['ready', 'completion']),
    // CSS selectors of the regions to scan; empty scans the whole page. A
    // selector that matches nothing is an audit error, never a clean scan.
    include: cssScope,
    // CSS selectors of regions to leave out (for example a third-party widget).
    exclude: cssScope,
    // The axe rule tags to run.
    tags: z.array(axeTag).min(1).max(20).default(DEFAULT_AXE_TAGS),
  })
  .strict();

// Clipping, occlusion and target size at the session's viewport plus extra
// breakpoints and a reflow case, swept in place and restored (src/audits/
// layout.ts). Exception `breakpoints` name suite viewports or extra breakpoints.
const layoutResponsiveConfig = z
  .object({
    ...auditCheckFields,
    id: z.literal('layout.responsive'),
    at: auditAtSchema.default(['ready', 'completion']),
    ...layoutAuditConfigSchema.shape,
    matrix: layoutMatrixSchema.prefault({}),
  })
  .strict();

// A screenshot of each checkpoint compared with a reviewed baseline from a
// user-supplied directory (src/audits/visual.ts). Runs never approve a
// baseline; a missing or incompatible baseline is never a pass. The default
// checkpoint is ready: the state before any agent action, the one most
// likely to repeat run after run.
const visualBaselineConfig = z
  .object({
    ...auditCheckFields,
    id: z.literal('visual.baseline'),
    at: auditAtSchema.default(['ready']),
    ...visualAuditConfigShape,
  })
  .strict();

export const auditConfigSchema = z.discriminatedUnion('id', [
  horizontalOverflowConfig,
  axeConfig,
  layoutResponsiveConfig,
  visualBaselineConfig,
]);
export type AuditConfig = z.infer<typeof auditConfigSchema>;
export type AuditId = AuditConfig['id'];

export const DEFAULT_AUDITS: AuditConfig[] = [
  { id: 'layout.horizontal-overflow', at: ['completion'] },
];

export const auditsConfigSchema = z
  .object({
    checks: z
      .array(auditConfigSchema)
      .max(20)
      .default(DEFAULT_AUDITS)
      .refine(
        (checks) =>
          new Set(checks.map((check) => check.id)).size === checks.length,
        'Each audit can be configured once',
      ),
    // Violations at or above this severity fail quality; needs_review
    // results never do. none reports findings without failing quality.
    failOn: failOnSchema.default('serious'),
    // Bound on one audit run at one checkpoint; a run past it is an error.
    // An audit entry's own timeoutMs overrides it.
    timeoutMs: z.number().int().min(1000).max(120000).default(15000),
  })
  .strict();
export type AuditsConfig = z.infer<typeof auditsConfigSchema>;

// A journey state to audit: the first observed state where `when` holds.
export const journeyStateSchema = <T extends z.ZodType>(check: T) =>
  z
    .object({
      name: z.string().regex(/^[a-z0-9-]+$/),
      when: check,
    })
    .strict();
