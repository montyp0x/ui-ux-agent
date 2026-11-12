// Comparison gates: which differences between a base and a candidate run fail
// `npm run compare` (exit 1). Parsed from a gate file (--gate), validated with
// Zod; every field is optional.
//
// Defaults: a NEW violation at or above failOn (the suite's audits.failOn
// unless the gate sets one) fails; so does a known violation that became
// gating (escalated), a gating base violation the candidate could not assess,
// a check the base assessed and the candidate did not, a journey/viewport the
// candidate did not run, and a journey/viewport that passed every base run
// but not every candidate run. needs_review items, model hypotheses and the
// runner's own observed findings (detours, policy blocks ...) never gate
// unless the gate turns them on.
import { z } from 'zod';
import { auditConfigSchema } from './audits/config.js';
import {
  SEVERITIES,
  failOnSchema,
  type FailOn,
  type Severity,
} from './audits/contract.js';

// Rule ids: `<audit id>/<rule id>`, `<audit id>/*`, or for the runner's own
// findings `finding/<category>` and `finding/*`.
const KNOWN_PREFIXES = new Set<string>([
  ...auditConfigSchema.options.map((option) => option.shape.id.value),
  'finding',
]);

const gateRuleSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[^\s/]+\/\S+$/,
        'A rule id is <audit id>/<rule id> or <audit id>/*',
      )
      .refine((id) => KNOWN_PREFIXES.has(id.slice(0, id.indexOf('/'))), {
        message: `A rule id starts with a known audit id or finding/ (${[...KNOWN_PREFIXES].join(', ')})`,
      }),
    // never: the rule's findings never gate. always: every eligible finding
    // of the rule gates, whatever its severity.
    gate: z.enum(['never', 'always']).optional(),
    // A threshold for this rule instead of the gate's failOn.
    failOn: failOnSchema.optional(),
  })
  .strict()
  .refine((rule) => (rule.gate === undefined) !== (rule.failOn === undefined), {
    message: 'A gate rule sets exactly one of gate or failOn',
  });

export const gateSchema = z
  .object({
    // Severity threshold for violations; defaults to the suite's
    // audits.failOn. none: no severity gates (rules with gate: always still do).
    failOn: failOnSchema.optional(),
    // Also gate needs_review items (undecided analyzer results).
    needsReview: z.boolean().default(false),
    // Also gate model hypotheses (usability concerns). They are unreviewed
    // model output; turning this on gates on model judgment.
    hypotheses: z.boolean().default(false),
    // Also gate the runner's own observed findings (detour, policy-block,
    // action-error, browser-error, data-cleanup, loop, selector-recovery).
    // They carry no severity, so they gate at every failOn except none.
    observed: z.boolean().default(false),
    // Also fail on gating findings present in both runs (known debt), not
    // only on new and escalated ones.
    persisting: z.boolean().default(false),
    // fail: lost coverage fails the gate (a check, run or gating finding the
    // base assessed and the candidate did not). report: list it only.
    unassessed: z.enum(['fail', 'report']).default('fail'),
    // regressions: fail when a journey/viewport passed in every base run and
    // not in every candidate run. any: fail on any non-passing candidate
    // run. ignore: functional outcomes do not gate.
    outcomes: z.enum(['regressions', 'any', 'ignore']).default('regressions'),
    // Per-rule overrides; an exact id wins over <audit id>/*.
    rules: z.array(gateRuleSchema).max(200).default([]),
  })
  .strict()
  .superRefine((gate, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of gate.rules.entries()) {
      if (seen.has(rule.id))
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: `Duplicate gate rule ${rule.id}`,
        });
      seen.add(rule.id);
    }
  });
export type GateInput = z.input<typeof gateSchema>;
export type Gate = z.infer<typeof gateSchema>;
// The gate as applied: failOn resolved.
export type ResolvedGate = Gate & { failOn: FailOn };

export const resolvedGateSchema = gateSchema.safeExtend({
  failOn: failOnSchema,
});

export function resolveGate(gate: Gate, suiteFailOn: FailOn): ResolvedGate {
  return { ...gate, failOn: gate.failOn ?? suiteFailOn };
}

// What the gate needs to know about a finding.
export type Gateable = {
  kind: 'audit' | 'observed' | 'hypothesis';
  gateKey: string;
  certainty: 'violation' | 'needs_review' | null;
  severity: Severity | null;
};

export function gateRule(gate: Gate, key: string) {
  return (
    gate.rules.find((rule) => rule.id === key) ??
    gate.rules.find((rule) => rule.id === `${key.slice(0, key.indexOf('/'))}/*`)
  );
}

// Whether the finding gates under this gate, by its own attributes.
export function gates(finding: Gateable, gate: ResolvedGate): boolean {
  if (finding.kind === 'hypothesis' && !gate.hypotheses) return false;
  if (finding.kind === 'observed' && !gate.observed) return false;
  if (finding.certainty === 'needs_review' && !gate.needsReview) return false;
  const rule = gateRule(gate, finding.gateKey);
  if (rule?.gate === 'never') return false;
  if (rule?.gate === 'always') return true;
  const threshold = rule?.failOn ?? gate.failOn;
  if (threshold === 'none') return false;
  // An unknown severity cannot be shown to be below the threshold.
  return (
    finding.severity === null ||
    SEVERITIES.indexOf(finding.severity) >= SEVERITIES.indexOf(threshold)
  );
}
