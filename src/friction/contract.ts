// Task-friction contracts: the optional reviewed reference paths a journey
// may declare (suite input), and the friction summary every run records
// (result output). The summary describes the automated agent's run, computed
// from its recorded event stream; it is not a measurement of human usability.
import { z } from 'zod';

const count = z.number().int().nonnegative();

const validRegex = (value: string) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
};
const pattern = z
  .string()
  .min(1)
  .max(500)
  .refine(validRegex, 'Invalid regex in a reference path');

export const ACTION_KINDS = [
  'link',
  'click',
  'fill',
  'select',
  'check',
  'press',
  'scroll',
  'wait',
  'key',
  'back',
] as const;

// Matches an executed action: its kind, a regex on its description, and for
// links and history back a regex on the destination path. At least one.
const actionMatcherFields = {
  action: z.enum(ACTION_KINDS).optional(),
  description: pattern.optional(),
  to: pattern.optional(),
};
const hasMatcher = (matcher: {
  action?: unknown;
  description?: unknown;
  to?: unknown;
}) =>
  matcher.action !== undefined ||
  matcher.description !== undefined ||
  matcher.to !== undefined;
export const actionMatcherSchema = z
  .object(actionMatcherFields)
  .strict()
  .refine(
    hasMatcher,
    'An action waypoint needs action, description or to (an allowance too)',
  );
export type ActionMatcher = z.infer<typeof actionMatcherSchema>;

export const waypointSchema = z.discriminatedUnion('kind', [
  // An observed page whose path matches `pattern`.
  z
    .object({
      kind: z.literal('page'),
      pattern,
      label: z.string().min(1).max(200).optional(),
    })
    .strict(),
  // An executed agent action (not a runner recovery) that did not fail.
  z
    .object({
      kind: z.literal('action'),
      ...actionMatcherFields,
      label: z.string().min(1).max(200).optional(),
    })
    .strict()
    .refine(
      hasMatcher,
      'An action waypoint needs action, description or to',
    ),
]);
export type Waypoint = z.infer<typeof waypointSchema>;

// A reviewed route through the product to the journey's goal. A journey may
// list several: alternate valid paths exist, and a run is compared with the
// closest. A comparison never decides an outcome or a verdict.
export const referencePathSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500).optional(),
    waypoints: z.array(waypointSchema).min(1).max(30),
    // false: waypoints may be reached in any order.
    ordered: z.boolean().default(true),
    // Agent actions the reviewed route needs; defaults to the number of
    // action waypoints.
    expectedActions: z.number().int().min(0).max(100).optional(),
    // Actions never compared, such as dismissing a cookie banner.
    allow: z.array(actionMatcherSchema).max(10).default([]),
  })
  .strict();
export type ReferencePath = z.infer<typeof referencePathSchema>;

export const referencePathsSchema = z
  .array(referencePathSchema)
  .min(1)
  .max(5)
  .refine(
    (paths) => new Set(paths.map((path) => path.name)).size === paths.length,
    'Reference path names must be unique in a journey',
  );

// --- The result: what the run's event stream shows ------------------------

export const FRICTION_KINDS = [
  // Returned to a page observed earlier: browser history back, or a
  // navigation back to an earlier page.
  'backtrack',
  // The same action dispatched again in a state where it was already tried
  // (the runner's loop check, visit 2 or later).
  'repeat',
  // A runner recovery after the selector found no match twice.
  'recovery',
  // An observed step on a configured detour (a look-alike page).
  'detour',
  // An action whose dispatch failed (an error, or a stale guard).
  'failed_attempt',
  // An action after which the observed state did not change (waits excluded).
  'no_effect',
] as const;

export const frictionItemSchema = z
  .object({
    kind: z.enum(FRICTION_KINDS),
    // product: an action the agent took on the product, or a page it
    // reached. overhead: the runner's own recovery, not a product action.
    actor: z.enum(['product', 'overhead']),
    description: z.string(),
    detail: z.string().nullable(),
    // The events.jsonl line (1-based) of the event that records it.
    line: z.number().int().min(1),
    // The observation step the event refers to.
    step: z.number().int(),
    // URL of the observed state at that step, when one was observed.
    url: z.string().nullable(),
    // Screenshots of the observed state at the step and of the next one.
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();
export type FrictionItem = z.infer<typeof frictionItemSchema>;

export const SIGNALS = [
  'backtracks',
  'repeats',
  'recoveries',
  'detours',
  'failedAttempts',
  'noEffect',
  'noMatchDecisions',
  'revisitReplans',
  'stalledReplans',
] as const;
export type Signal = (typeof SIGNALS)[number];

export const RUBRIC_DIMENSIONS = [
  'discoverability',
  'feedback',
  'clarity',
  'recovery',
] as const;

export const rubricEntrySchema = z
  .object({
    dimension: z.enum(RUBRIC_DIMENSIONS),
    // The question a human reviewer answers from the linked evidence.
    question: z.string().min(1),
    // The run's counts that bear on the question. Evidence to inspect, not
    // a score.
    signals: z.array(z.object({ signal: z.enum(SIGNALS), count }).strict()),
    // no_signals means nothing was counted, not that the dimension is good.
    status: z.enum(['signals_observed', 'no_signals']),
    // Always pending: the engine judges no dimension.
    review: z.literal('pending'),
  })
  .strict();
export type RubricEntry = z.infer<typeof rubricEntrySchema>;

export const referenceComparisonSchema = z
  .object({
    name: z.string(),
    ordered: z.boolean(),
    // Every waypoint matched.
    followed: z.boolean(),
    matched: count,
    total: count,
    waypoints: z.array(
      z
        .object({
          index: count,
          label: z.string(),
          matched: z.boolean(),
          line: z.number().int().min(1).nullable(),
          step: z.number().int().nullable(),
        })
        .strict(),
    ),
    expectedActions: count,
    // Agent actions compared: executed agent actions minus allowances.
    comparedActions: count,
    allowedActions: count,
    // comparedActions beyond expectedActions. Counted, never judged.
    extraActions: count,
  })
  .strict();
export type ReferenceComparison = z.infer<typeof referenceComparisonSchema>;

export const FRICTION_NOTE =
  'These counts describe the automated agent run, computed from its recorded event stream. They are not human usability performance: agent actions, agent duration and synthetic success rates are not human task time, success rate or satisfaction. Each item links to the observed step for human review.';
export const REFERENCE_NOTE =
  'Reference paths are reviewed examples of valid routes, not the only valid routes. Extra actions alone do not establish poor usability; inspect the linked steps before drawing a conclusion.';

export const frictionSchema = z
  .object({
    version: z.literal(1),
    basis: z.literal('agent_run'),
    note: z.string(),
    // The events.jsonl lines the summary was computed from.
    events: z
      .object({
        first: z.number().int().min(1).nullable(),
        last: z.number().int().min(1).nullable(),
        // Friction-relevant events read.
        considered: count,
        // Friction-relevant events that did not match their contract.
        unparsed: count,
      })
      .strict(),
    actions: z
      .object({
        // Every dispatched action (action_result events).
        executed: count,
        // Agent-selected actions on the product, waits excluded.
        product: count,
        waits: count,
        // Runner recovery actions (not chosen by the selector).
        recovery: count,
      })
      .strict(),
    // Planner and runner work that is not a product action.
    overhead: z
      .object({
        plannerRefreshes: count,
        refreshReasons: z.record(z.string(), count),
        noMatchDecisions: count,
        // Replans before re-dispatching an action in an already-tried state.
        revisitReplans: count,
        recoveryActions: count,
      })
      .strict(),
    counts: z
      .object({
        backtracks: count,
        repeats: count,
        recoveries: count,
        detours: count,
        failedAttempts: count,
        noEffect: count,
      })
      .strict(),
    // In events.jsonl order.
    items: z.array(frictionItemSchema),
    rubric: z.array(rubricEntrySchema),
    // Plan events that raised model concerns: hypotheses pending review (the
    // concerns themselves are the run's `hypothesis` findings).
    hypotheses: z.array(
      z
        .object({
          line: z.number().int().min(1),
          step: z.number().int(),
          concerns: count,
        })
        .strict(),
    ),
    // Null without configured reference paths.
    reference: z
      .object({
        note: z.string(),
        closest: z.string().nullable(),
        paths: z.array(referenceComparisonSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Friction = z.infer<typeof frictionSchema>;
