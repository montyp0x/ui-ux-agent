// Suite configuration for audits: which audits run, at which checkpoints, and
// which finding severity fails the quality verdict. Audits run only at the
// checkpoints listed here, never after every action.
import { z } from 'zod';
import { failOnSchema } from './contract.js';

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

// One entry per audit. Audits with options add their own member; the id is
// the discriminator, so an unknown audit is a configuration error.
const horizontalOverflowConfig = z
  .object({
    id: z.literal('layout.horizontal-overflow'),
    // Reads every state observed since its previous checkpoint, so the
    // default single completion run covers the whole journey.
    at: auditAtSchema.default(['completion']),
  })
  .strict();

export const auditConfigSchema = z.discriminatedUnion('id', [
  horizontalOverflowConfig,
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
