// The audit contract: what an audit returns (parsed at the driver boundary)
// and the audit records stored in results.json. Audits are objective checks
// run at configured checkpoints; model concerns stay in `findings` as
// hypotheses and never become audit findings.
import { z } from 'zod';

// Bumped when an audit record changes shape; stored on every result.
export const AUDIT_CONTRACT_VERSION = 1;

const count = z.number().int().nonnegative();
// Guidance links end up in the HTML report: HTTP(S) only.
const helpUrl = z
  .url()
  .refine(
    (value) => /^https?:$/.test(new URL(value).protocol),
    'helpUrl must be HTTP(S)',
  )
  .nullable();

// The drivers an audit can declare support for.
export const driverKindSchema = z.enum(['playwright', 'macos']);
export type DriverKind = z.infer<typeof driverKindSchema>;

// Ordered from least to most severe (axe-core's impact scale).
export const SEVERITIES = ['minor', 'moderate', 'serious', 'critical'] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

// violation: the rule failed. needs_review: the audit completed but could not
// decide this item and a person must check it (axe-core's "incomplete"
// results). needs_review is shown separately and never part of the quality
// verdict; it is not an audit-level `incomplete`.
export const certaintySchema = z.enum(['violation', 'needs_review']);
export type Certainty = z.infer<typeof certaintySchema>;

// clean: ran over the whole checkpoint, no violations (needs_review findings
// may be listed). findings: at least one violation. incomplete: the audit did
// not fully run over the checkpoint state (its violations are still
// reported). unsupported: the driver does not support the audit; it was not
// run. error: the audit itself failed (analyzer exception, a configured scope
// that matched nothing, timeout or invalid output); it says nothing about the
// UI and is never clean.
export const auditStatusSchema = z.enum([
  'clean',
  'findings',
  'incomplete',
  'unsupported',
  'error',
]);
export type AuditStatus = z.infer<typeof auditStatusSchema>;

// ready: the first observed state after the ready assertion and setup.
// state: the first observed state where a journey's declared state holds.
// completion: the final state when the journey ends, whatever its outcome.
export const checkpointKindSchema = z.enum(['ready', 'state', 'completion']);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const auditCheckpointSchema = z
  .object({
    // ready | state:<name> | completion
    id: z.string().min(1),
    kind: checkpointKindSchema,
    // The declared state's name for kind state, otherwise null.
    name: z.string().min(1).nullable(),
    // Observation step of the audited state (-1 when none was observed).
    step: z.number().int(),
    url: z.string().nullable(),
    screenshot: z.string().nullable(),
  })
  .strict();
export type AuditCheckpoint = z.infer<typeof auditCheckpointSchema>;

export const auditTargetSchema = z
  .object({
    // Human-readable element or region (role and name, an HTML snippet ...).
    description: z.string().min(1),
    // A selector the analyzer reported, for reproduction; null when none.
    selector: z.string().min(1).nullable(),
    // A short markup or accessibility-tree excerpt of the element.
    snippet: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type AuditTarget = z.infer<typeof auditTargetSchema>;

// The analyzer that produced a run, for example axe-core 4.10.2.
export const analyzerSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1).nullable(),
  })
  .strict();
export type Analyzer = z.infer<typeof analyzerSchema>;

// One finding as an audit reports it. The runner adds the audit id, source,
// checkpoint and reproduction context.
export const auditOutputFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    // The analyzer's impact; null when it reports none. A null-severity
    // violation counts as gating unless failOn is none.
    severity: severitySchema.nullable(),
    certainty: certaintySchema,
    description: z.string().min(1),
    // Applicable guidance (for example a WCAG understanding document).
    helpUrl,
    // Standards and rule-set tags, for example wcag2a, wcag412.
    tags: z.array(z.string().min(1)).max(50).default([]),
    // Affected elements in total; `targets` may be a sample of them.
    nodeCount: count.optional(),
    targets: z.array(auditTargetSchema).max(50),
    // The observed state the finding was measured in, when it is not the
    // checkpoint's own state (audits that read earlier observations).
    at: z
      .object({
        step: z.number().int(),
        url: z.string(),
        screenshot: z.string().nullable(),
      })
      .strict()
      .optional(),
    // Evidence files the audit wrote (inside the run directory).
    files: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();
export type AuditOutputFinding = z.input<typeof auditOutputFindingSchema>;

// What every audit returns: the runner derives the run status from it.
export const auditOutputSchema = z
  .object({
    // False when the audit could not cover the whole checkpoint state.
    complete: z.boolean(),
    // Why the audit is incomplete, or other machine detail.
    detail: z.string().nullable().default(null),
    // States the audit evaluated (core audits over recorded observations
    // can cover more than one).
    observations: count.default(1),
    // The analyzer and its version; null for the engine's own checks.
    analyzer: analyzerSchema.nullable().default(null),
    // What the run does not cover even when complete (for example: an
    // automated scan does not prove WCAG conformance; cross-origin frames
    // were not scanned).
    limitations: z.array(z.string().min(1)).max(20).default([]),
    findings: z.array(auditOutputFindingSchema).max(500),
  })
  .strict();
export type AuditOutput = z.input<typeof auditOutputSchema>;
export type ParsedAuditOutput = z.infer<typeof auditOutputSchema>;

export const auditFindingSchema = z
  .object({
    auditId: z.string().min(1),
    // The analyzer that produced it: builtin, axe-core ...
    source: z.string().min(1),
    analyzer: analyzerSchema.nullable(),
    ruleId: z.string().min(1),
    severity: severitySchema.nullable(),
    certainty: certaintySchema,
    description: z.string().min(1),
    helpUrl,
    tags: z.array(z.string().min(1)),
    // Affected elements in total (at least the number of targets).
    nodeCount: count,
    // A sample of the affected elements.
    targets: z.array(auditTargetSchema),
    // Index into audits.runs of the run that produced it.
    run: count,
    // Whether it fails the quality verdict under the configured threshold.
    gating: z.boolean(),
    evidence: z
      .object({
        screenshot: z.string().nullable(),
        files: z.array(z.string().min(1)),
      })
      .strict(),
    reproduction: z
      .object({
        journey: z.string(),
        viewport: z
          .object({ name: z.string(), width: count, height: count })
          .strict(),
        checkpoint: z.string().min(1),
        step: z.number().int(),
        url: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type AuditFinding = z.infer<typeof auditFindingSchema>;

export const auditRunSchema = z
  .object({
    auditId: z.string().min(1),
    source: z.string().min(1),
    checkpoint: auditCheckpointSchema,
    analyzer: analyzerSchema.nullable(),
    status: auditStatusSchema,
    // Unsupported reason, error message, incompleteness reason, or null.
    detail: z.string().nullable(),
    durationMs: z.number().nonnegative(),
    // Observed states the run evaluated (0 when unsupported or errored).
    observations: count,
    limitations: z.array(z.string().min(1)),
    // Indices into audits.findings.
    findings: z.array(count),
  })
  .strict();
export type AuditRun = z.infer<typeof auditRunSchema>;

// Findings at or above this severity fail quality; none never fails.
export const failOnSchema = z.enum([...SEVERITIES, 'none']);
export type FailOn = z.infer<typeof failOnSchema>;

export const auditsResultSchema = z
  .object({
    contractVersion: z.literal(AUDIT_CONTRACT_VERSION),
    failOn: failOnSchema,
    // Configured audits, in suite order.
    configured: z.array(z.string().min(1)),
    runs: z.array(auditRunSchema),
    findings: z.array(auditFindingSchema),
    // Configured audit checkpoints that were never reached in this run.
    notReached: z.array(
      z.object({ auditId: z.string().min(1), at: z.string().min(1) }).strict(),
    ),
  })
  .strict();
export type AuditsResult = z.infer<typeof auditsResultSchema>;

export const isGating = (
  finding: Pick<AuditFinding, 'severity' | 'certainty'>,
  failOn: FailOn,
): boolean =>
  failOn !== 'none' &&
  finding.certainty === 'violation' &&
  // An unknown severity cannot be shown to be below the threshold.
  (finding.severity === null ||
    SEVERITIES.indexOf(finding.severity) >= SEVERITIES.indexOf(failOn));

export const emptyAudits = (failOn: FailOn = 'serious'): AuditsResult => ({
  contractVersion: AUDIT_CONTRACT_VERSION,
  failOn,
  configured: [],
  runs: [],
  findings: [],
  notReached: [],
});
