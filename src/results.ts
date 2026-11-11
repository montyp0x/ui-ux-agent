// The machine-readable run result contract (result.json, results.json and the
// journey_finished event). Version 2 kept every version-1 field (status,
// reason, checks, findings ...) and added a typed functional `outcome` and a
// separate `quality` verdict. Version 3 adds `audits` (checkpoint audit runs
// and their findings, see src/audits/contract.ts); the horizontal overflow
// check moved there from `findings`.
import { z } from 'zod';
import { auditsResultSchema } from './audits/contract.js';

export const RESULT_VERSION = 3;

const count = z.number().int().nonnegative();

export const callStatsSchema = z
  .object({
    calls: count,
    durationMs: z.number().nonnegative(),
    inputTokens: count,
    outputTokens: count,
  })
  .strict();
export type CallStats = z.infer<typeof callStatsSchema>;
export const usageSchema = z
  .object({ planner: callStatsSchema, selector: callStatsSchema })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

export const findingSchema = z
  .object({
    // observed: measured by the runner or a driver. hypothesis: a model
    // concern that needs human review; never part of a verdict.
    kind: z.enum(['observed', 'hypothesis']),
    category: z.string().min(1),
    description: z.string(),
    step: z.number().int(),
    screenshot: z.string(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const statusSchema = z.enum(['passed', 'failed', 'blocked', 'error']);
export type Status = z.infer<typeof statusSchema>;

// What kind of stop ended the journey.
export const outcomeCategorySchema = z.enum([
  'passed',
  // An independent outcome assertion was evaluated and did not hold.
  'assertion_failure',
  // The journey could not start: ready assertion or setup step.
  'precondition_failure',
  // The harness's scope or request policy stopped the journey.
  'policy_block',
  // A dispatch guard rejected an action because the UI changed after it was offered.
  'stale_action',
  // The agent repeated the same action in the same state.
  'agent_loop',
  // The agent found no offered action to continue with.
  'agent_no_path',
  // The step or time budget ran out before the outcome was observed.
  'budget_exhausted',
  'auth_failure',
  'model_error',
  'infrastructure_error',
  'unknown',
]);
export type OutcomeCategory = z.infer<typeof outcomeCategorySchema>;

// Where the evidence for the outcome points. Only `assertion` is evidence about
// the application's state; every other source, including `unknown`, does not
// by itself establish a product defect.
export const outcomeSourceSchema = z.enum([
  'assertion',
  'agent',
  'model',
  'harness',
  'environment',
  'unknown',
]);
export type OutcomeSource = z.infer<typeof outcomeSourceSchema>;

// Stable reason codes. Each code fixes its status, category and source, so the
// same failure always produces the same classification.
export const OUTCOME_CODES = {
  assertions_passed: ['passed', 'passed', 'assertion'],
  content_readiness_timeout: ['failed', 'assertion_failure', 'assertion'],
  ready_not_reached: ['blocked', 'precondition_failure', 'unknown'],
  setup_not_offered: ['blocked', 'precondition_failure', 'unknown'],
  setup_action_failed: ['blocked', 'precondition_failure', 'unknown'],
  setup_stale_action: ['blocked', 'stale_action', 'harness'],
  scope_exit: ['blocked', 'policy_block', 'harness'],
  unauthorized_response: ['blocked', 'auth_failure', 'environment'],
  repeated_action: ['failed', 'agent_loop', 'agent'],
  selector_no_path: ['failed', 'agent_no_path', 'agent'],
  recovery_scroll_stalled: ['failed', 'agent_no_path', 'agent'],
  budget_max_steps: ['failed', 'budget_exhausted', 'unknown'],
  budget_deadline: ['failed', 'budget_exhausted', 'unknown'],
  budget_deadline_before_stage: ['failed', 'budget_exhausted', 'unknown'],
  budget_stage_timeout: ['failed', 'budget_exhausted', 'unknown'],
  // A planner or selector call was cut off at the journey deadline: by the
  // journey's abort signal, the call's own timeout or the limiter's slot wait,
  // whichever ended first.
  budget_deadline_abort: ['failed', 'budget_exhausted', 'unknown'],
  // The model endpoint's rate-limit cooldown would end past the deadline.
  budget_model_rate_limit: ['failed', 'budget_exhausted', 'model'],
  model_call_failed: ['error', 'model_error', 'model'],
  model_invalid_output: ['error', 'model_error', 'model'],
  driver_capability_missing: ['error', 'infrastructure_error', 'harness'],
  driver_error: ['error', 'infrastructure_error', 'unknown'],
  evidence_capture_failed: ['error', 'infrastructure_error', 'unknown'],
  session_cleanup_failed: ['error', 'infrastructure_error', 'unknown'],
  journey_not_finished: ['error', 'unknown', 'unknown'],
  unclassified_error: ['error', 'unknown', 'unknown'],
} as const satisfies Record<
  string,
  readonly [Status, OutcomeCategory, OutcomeSource]
>;
export type OutcomeCode = keyof typeof OUTCOME_CODES;
export const outcomeCodeSchema = z.enum(
  Object.keys(OUTCOME_CODES) as [OutcomeCode, ...OutcomeCode[]],
);

export const outcomeSchema = z
  .object({
    code: outcomeCodeSchema,
    category: outcomeCategorySchema,
    source: outcomeSourceSchema,
    // Runner stage when the outcome was decided (start, ready, setup, observe,
    // checks, content, candidates, plan, choose, loop_check, execute, finish).
    stage: z.string().min(1),
    // Observation step the outcome refers to.
    step: z.number().int(),
    // First line of the underlying error, or other machine detail.
    detail: z.string().nullable(),
    evidence: z
      .object({
        // Screenshot of the deciding state, when one was captured.
        screenshot: z.string().nullable(),
        // events.jsonl event names that record the decision.
        events: z.array(z.string().min(1)),
        // Indices into `checks` that were false when the outcome was decided.
        failedChecks: z.array(count),
      })
      .strict(),
    // Run-wide counts that may explain the outcome without being its cause.
    signals: z
      .object({
        staleActions: count,
        actionErrors: count,
        policyBlocks: count,
        browserErrors: count,
      })
      .strict(),
  })
  .strict()
  .superRefine((outcome, ctx) => {
    const [, category, source] = OUTCOME_CODES[outcome.code];
    if (outcome.category !== category || outcome.source !== source)
      ctx.addIssue({
        code: 'custom',
        message: `Outcome ${outcome.code} must be ${category}/${source}`,
      });
  });
export type Outcome = z.infer<typeof outcomeSchema>;

// Quality checks run independently of the functional outcome. Built-in checks
// cover the whole run; audit checks summarize one configured audit's runs at
// its checkpoints.
export const qualityCheckSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(['builtin', 'audit']),
    // inconclusive: the check ran but harness interference (for example
    // request-policy blocks) could explain what it measured. errored: the
    // check itself failed to run.
    status: z.enum(['passed', 'failed', 'inconclusive', 'errored']),
    // Observed states the check evaluated.
    observations: count,
    // Indices into `findings` that the check produced (built-in checks).
    findings: z.array(count),
    // Audit checks: indices into audits.runs and into audits.findings (the
    // ones at or above the failOn threshold). Null for built-in checks.
    audit: z
      .object({ runs: z.array(count), findings: z.array(count) })
      .strict()
      .nullable(),
    detail: z.string().nullable(),
  })
  .strict();
export type QualityCheck = z.infer<typeof qualityCheckSchema>;
export const qualityGapSchema = z
  .object({ id: z.string().min(1), reason: z.string().min(1) })
  .strict();
export type QualityGap = z.infer<typeof qualityGapSchema>;
export const qualitySchema = z
  .object({
    // pass needs at least one executed check, every executed check passed and
    // none inconclusive or errored, and every configured audit run and
    // supported. Zero executed checks is not_evaluated.
    verdict: z.enum(['pass', 'fail', 'not_evaluated']),
    reason: z.string().min(1),
    executed: z.array(qualityCheckSchema),
    // Applicable to this run but not executed (for example no state observed).
    skipped: z.array(qualityGapSchema),
    // Not available for this platform or engine version.
    unsupported: z.array(qualityGapSchema),
  })
  .strict();
export type Quality = z.infer<typeof qualitySchema>;

export const resultSchema = z
  .object({
    resultVersion: z.literal(RESULT_VERSION),
    journey: z.string(),
    viewport: z.string(),
    // 1-based repetition number when a journey/viewport is run several times.
    attempt: z.number().int().min(1),
    // Model calls, latency and tokens for this run, from model_call events.
    usage: usageSchema,
    // The {{marker}} value used in this run, when the journey has one.
    marker: z.string().optional(),
    // Functional outcome: decided by the independent outcome assertions.
    status: statusSchema,
    reason: z.string(),
    outcome: outcomeSchema,
    // Quality verdict: separate from, and never changing, the functional outcome.
    quality: qualitySchema,
    steps: count,
    durationMs: z.number().nonnegative(),
    checks: z.array(z.boolean()),
    findings: z.array(findingSchema),
    // Objective audits at configured checkpoints; model hypotheses stay in
    // `findings`.
    audits: auditsResultSchema,
    trace: z.string(),
    video: z.string().nullable(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (OUTCOME_CODES[result.outcome.code][0] !== result.status)
      ctx.addIssue({
        code: 'custom',
        message: `Outcome ${result.outcome.code} does not match status ${result.status}`,
      });
  });
export type Result = z.infer<typeof resultSchema>;

// For consumers reading results.json from disk.
export function parseResults(json: string): Result[] {
  return z.array(resultSchema).parse(JSON.parse(json));
}

export const emptySignals = (): Outcome['signals'] => ({
  staleActions: 0,
  actionErrors: 0,
  policyBlocks: 0,
  browserErrors: 0,
});
