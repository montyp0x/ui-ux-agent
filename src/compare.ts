// Compatible-run comparison: which findings are new, persisting, resolved or
// unassessed between a base run and a candidate run, and whether the
// candidate passes the configured gate (src/gate.ts).
//
// Two runs are compared only when their identities say they measured the
// same thing (same suite configuration, engine and contract versions,
// platform, browser, OS and model configuration); otherwise the comparison is
// invalid and names every field that differs.
//
// A finding is identified without volatile data: no step, screenshot or file
// path, timestamp, run marker, candidate id, URL origin or query, and no
// measurement digits in descriptions. Audit findings are compared per
// sampled target, so a new element breaking a known rule is new while the
// known ones persist. Absence counts as resolved only where the candidate
// assessed the same check (audit, checkpoint and page): a missing, errored,
// unsupported, incomplete or unreached check leaves the base finding
// `unassessed`, never resolved.
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AUDIT_CONTRACT_VERSION,
  certaintySchema,
  severitySchema,
  SEVERITIES,
  type Severity,
} from './audits/contract.js';
import {
  ENGINE_VERSION,
  canonicalJSON,
  runIdentitySchema,
  sha256,
  type RunIdentity,
} from './identity.js';
import { RESULT_VERSION, parseResults, type Result } from './results.js';
import {
  gates,
  resolveGate,
  resolvedGateSchema,
  type Gate,
  type ResolvedGate,
} from './gate.js';

export const COMPARISON_VERSION = 1;

// A problem with the inputs themselves (unreadable or corrupt results, the
// same run twice): exit 2, unlike an incompatible pair of valid runs.
export class ComparisonInputError extends Error {}

const id = z.string().regex(/^[0-9a-f]{16}$/);
const count = z.number().int().nonnegative();

export const findingInstanceSchema = z
  .object({
    // Stable identity of this finding (per sampled target for audits).
    id,
    // Identity of the finding without its target: all targets of one audit
    // finding share it.
    groupId: id,
    kind: z.enum(['audit', 'observed', 'hypothesis']),
    journey: z.string(),
    viewport: z.string(),
    // The suite environment (src/environments.ts); absent without one.
    environment: z.string().optional(),
    auditId: z.string().nullable(),
    ruleId: z.string().min(1),
    // The gate rule key: <audit id>/<rule id>, or finding/<category>.
    gateKey: z.string().min(1),
    // ready | state:<name> | completion; null for run findings.
    checkpoint: z.string().nullable(),
    // URL path where the finding was measured (no origin, query or hash).
    path: z.string().nullable(),
    tags: z.array(z.string()),
    target: z
      .object({ description: z.string(), selector: z.string().nullable() })
      .strict()
      .nullable(),
    certainty: certaintySchema.nullable(),
    severity: severitySchema.nullable(),
    description: z.string(),
    // Attempts (repeat numbers) that reported it.
    attempts: z.array(z.number().int().min(1)),
    // The audit reported more affected elements than it sampled.
    sampled: z.boolean(),
    // Measured at its checkpoint's own page (false for audits that read
    // states observed between checkpoints).
    atCheckpoint: z.boolean(),
    // Local evidence of the first report (the run's own files).
    evidence: z
      .object({
        screenshot: z.string().nullable(),
        files: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type FindingInstance = z.infer<typeof findingInstanceSchema>;

export const unassessedReasonSchema = z.enum([
  // The candidate has no result for the journey/viewport.
  'run_missing',
  // The audit was not configured in the candidate.
  'not_run',
  // The checkpoint was configured but never reached.
  'not_reached',
  'unsupported',
  'error',
  // The audit ran but could not cover the whole state (for example no
  // approved visual baseline).
  'incomplete',
  // The checkpoint was assessed on other pages only.
  'path_not_assessed',
  // The rule still fires and the candidate sampled other elements.
  'sampled',
]);
export type UnassessedReason = z.infer<typeof unassessedReasonSchema>;

export const checkStateSchema = z.enum([
  'assessed',
  'incomplete',
  'error',
  'unsupported',
  'not_reached',
  'not_run',
]);
export type CheckState = z.infer<typeof checkStateSchema>;

const fieldSchema = z
  .object({
    field: z.string().min(1),
    base: z.string(),
    candidate: z.string(),
    message: z.string().min(1),
  })
  .strict();
export type ComparisonField = z.infer<typeof fieldSchema>;

const sideOutcome = z
  .object({ runs: count, passed: count })
  .strict()
  .nullable();

export const gateFailureSchema = z
  .object({
    code: z.enum([
      'new_finding',
      'escalated_finding',
      'persisting_finding',
      'unassessed_finding',
      'coverage_lost',
      'run_missing',
      'outcome_regression',
      'outcome_not_passed',
    ]),
    message: z.string().min(1),
    // The finding instance id, when the failure is about one.
    finding: id.nullable(),
  })
  .strict();
export type GateFailure = z.infer<typeof gateFailureSchema>;

export const comparisonSchema = z
  .object({
    comparisonVersion: z.literal(COMPARISON_VERSION),
    engineVersion: z.string().min(1),
    base: z
      .object({ run: z.string(), identity: runIdentitySchema.nullable() })
      .strict(),
    candidate: z
      .object({ run: z.string(), identity: runIdentitySchema.nullable() })
      .strict(),
    // False: the runs did not measure the same thing; nothing below is
    // computed and `incompatibilities` says why.
    compatible: z.boolean(),
    incompatibilities: z.array(fieldSchema),
    // Differences that do not invalidate the comparison but qualify it.
    warnings: z.array(fieldSchema),
    outcomes: z.array(
      z
        .object({
          journey: z.string(),
          viewport: z.string(),
          environment: z.string().optional(),
          base: sideOutcome,
          candidate: sideOutcome,
          // Passed in every base run, not in every candidate run.
          regression: z.boolean(),
        })
        .strict(),
    ),
    findings: z
      .object({
        new: z.array(
          z
            .object({ candidate: findingInstanceSchema, gating: z.boolean() })
            .strict(),
        ),
        persisting: z.array(
          z
            .object({
              base: findingInstanceSchema,
              candidate: findingInstanceSchema,
              // Did not gate in the base, gates in the candidate.
              escalated: z.boolean(),
              gating: z.boolean(),
            })
            .strict(),
        ),
        resolved: z.array(z.object({ base: findingInstanceSchema }).strict()),
        unassessed: z.array(
          z
            .object({
              base: findingInstanceSchema,
              reason: unassessedReasonSchema,
              detail: z.string(),
              gating: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
    // Every audit checkpoint either run configured or recorded.
    checks: z.array(
      z
        .object({
          journey: z.string(),
          viewport: z.string(),
          environment: z.string().optional(),
          auditId: z.string().min(1),
          checkpoint: z.string().min(1),
          base: checkStateSchema,
          candidate: checkStateSchema,
          // Assessed in the base, not in the candidate.
          coverageLost: z.boolean(),
        })
        .strict(),
    ),
    counts: z
      .object({
        new: count,
        persisting: count,
        resolved: count,
        unassessed: count,
        coverageLost: count,
      })
      .strict(),
    // Null when the comparison is invalid.
    gate: z
      .object({
        passed: z.boolean(),
        config: resolvedGateSchema,
        failures: z.array(gateFailureSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Comparison = z.infer<typeof comparisonSchema>;

// ---------------------------------------------------------------- loading

export type LoadedRun = {
  directory: string;
  results: Result[] | null;
  identity: RunIdentity | null;
  // Why this run cannot be compared, though its file is readable.
  problems: ComparisonField[];
};

// Reads <run>/results.json (or a results.json path).
export async function loadRun(
  path: string,
  side: 'base' | 'candidate',
): Promise<LoadedRun> {
  let file = resolve(path);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new ComparisonInputError(`${side} run ${path} does not exist`);
  }
  if (info.isDirectory()) file = join(file, 'results.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (caught) {
    throw new ComparisonInputError(
      `Cannot read ${side} results ${file}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  const directory = info.isDirectory() ? resolve(path) : resolve(file, '..');
  if (!Array.isArray(raw) || !raw.length)
    throw new ComparisonInputError(`${side} results ${file} hold no results`);
  const versions = [
    ...new Set(
      raw.map((entry: unknown) =>
        String(
          entry && typeof entry === 'object' && 'resultVersion' in entry
            ? (entry as { resultVersion: unknown }).resultVersion
            : 'none',
        ),
      ),
    ),
  ];
  if (versions.some((version) => version !== String(RESULT_VERSION)))
    return {
      directory,
      results: null,
      identity: null,
      problems: [
        {
          field: 'engine.resultVersion',
          base: side === 'base' ? versions.join(',') : '',
          candidate: side === 'candidate' ? versions.join(',') : '',
          message: `The ${side} run's results are resultVersion ${versions.join(', ')}; this engine compares resultVersion ${RESULT_VERSION} runs only`,
        },
      ],
    };
  let results: Result[];
  try {
    results = parseResults(JSON.stringify(raw));
  } catch (caught) {
    throw new ComparisonInputError(
      `${side} results ${file} do not match the result contract: ${caught instanceof Error ? caught.message.split('\n')[0] : String(caught)}`,
    );
  }
  const identities = [
    ...new Set(
      results.map((result) =>
        result.identity ? canonicalJSON(result.identity) : 'none',
      ),
    ),
  ];
  if (identities.includes('none'))
    return {
      directory,
      results,
      identity: null,
      problems: [
        {
          field: 'identity',
          base: side === 'base' ? 'none' : 'recorded',
          candidate: side === 'candidate' ? 'none' : 'recorded',
          message: `The ${side} run has no run identity (recorded by an engine before run identity existed, or by a caller that removed it); it cannot be shown compatible`,
        },
      ],
    };
  if (identities.length > 1)
    return {
      directory,
      results,
      identity: null,
      problems: [
        {
          field: 'identity',
          base: side === 'base' ? 'differs between results' : '',
          candidate: side === 'candidate' ? 'differs between results' : '',
          message: `The ${side} run's results record ${identities.length} different run identities`,
        },
      ],
    };
  return { directory, results, identity: results[0]!.identity!, problems: [] };
}

// ---------------------------------------------------------- compatibility

const show = (value: unknown): string =>
  value === null || value === undefined
    ? 'none'
    : typeof value === 'string'
      ? value
      : canonicalJSON(value);

export function compatibility(
  base: RunIdentity,
  candidate: RunIdentity,
): { incompatibilities: ComparisonField[]; warnings: ComparisonField[] } {
  const incompatibilities: ComparisonField[] = [];
  const warnings: ComparisonField[] = [];
  const field = (
    list: ComparisonField[],
    name: string,
    a: unknown,
    b: unknown,
    message: string,
  ) => {
    if (show(a) !== show(b))
      list.push({ field: name, base: show(a), candidate: show(b), message });
  };
  const must = (name: string, a: unknown, b: unknown, message: string) =>
    field(incompatibilities, name, a, b, message);
  must(
    'identityVersion',
    base.identityVersion,
    candidate.identityVersion,
    'The runs record identity in different versions',
  );
  must(
    'engine.version',
    base.engine.version,
    candidate.engine.version,
    'Different engine versions can measure the same UI differently',
  );
  must(
    'engine.resultVersion',
    base.engine.resultVersion,
    candidate.engine.resultVersion,
    'Different result contracts',
  );
  must(
    'engine.auditContractVersion',
    base.engine.auditContractVersion,
    candidate.engine.auditContractVersion,
    'Different audit contracts',
  );
  must(
    'suite.hash',
    base.suite.hash,
    candidate.suite.hash,
    'The suite configuration differs (journeys, checks, audits, viewports, evidence policy ...); compare runs of the same suite',
  );
  must(
    'environment.platform',
    base.environment.platform,
    candidate.environment.platform,
    'Different platforms',
  );
  must(
    'environment.driver',
    base.environment.driver,
    candidate.environment.driver,
    'Different drivers',
  );
  for (const key of ['name', 'build', 'version', 'headless'] as const)
    must(
      `environment.browser.${key}`,
      base.environment.browser?.[key] ?? null,
      candidate.environment.browser?.[key] ?? null,
      'A different browser renders and behaves differently',
    );
  for (const key of ['platform', 'arch'] as const)
    must(
      `environment.os.${key}`,
      base.environment.os[key],
      candidate.environment.os[key],
      'A different operating system renders differently (fonts, scroll bars, layout)',
    );
  must(
    'models',
    base.models,
    candidate.models,
    'Different model configuration takes different paths through the UI; compare runs with the same planner and selector',
  );
  const warn = (name: string, a: unknown, b: unknown, message: string) =>
    field(warnings, name, a, b, message);
  if (!base.build || !candidate.build)
    warnings.push({
      field: 'build',
      base: show(base.build?.id),
      candidate: show(candidate.build?.id),
      message:
        'A build is unknown (pass --build or UIUX_BUILD); the comparison cannot say which builds it compares',
    });
  else if (base.build.id === candidate.build.id)
    warnings.push({
      field: 'build',
      base: base.build.id,
      candidate: candidate.build.id,
      message:
        'Both runs record the same build: differences come from the run, not from a change',
    });
  if (
    base.environment.browser &&
    candidate.environment.browser &&
    (base.environment.browser.version === null ||
      candidate.environment.browser.version === null)
  )
    warnings.push({
      field: 'environment.browser.version',
      base: show(base.environment.browser.version),
      candidate: show(candidate.environment.browser.version),
      message: 'The browser version is unknown on a side; it may differ',
    });
  warn(
    'environment.os.release',
    base.environment.os.release,
    candidate.environment.os.release,
    'A different OS release can render differently',
  );
  warn(
    'environment.node',
    base.environment.node,
    candidate.environment.node,
    'Different Node.js versions',
  );
  warn(
    'suite.target',
    base.suite.target,
    candidate.suite.target,
    'The runs tested different deployments (expected for different builds)',
  );
  warn(
    'suite.selection',
    base.suite.selection,
    candidate.suite.selection,
    'The runs selected different journeys, viewports or repeat counts; what one run did not cover is unassessed',
  );
  return { incompatibilities, warnings };
}

// ----------------------------------------------------- finding identities

const hash16 = (parts: unknown[]): string =>
  sha256(canonicalJSON(parts)).slice(0, 16);

// Digits carry measurements (pixels, counts, ports, steps); they would make
// the same finding look new.
const withoutDigits = (text: string): string => text.replace(/\d+/g, '#');

function pathOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url.replace(/[?#].*$/, '');
  }
}

const severityRank = (severity: Severity | null): number =>
  severity === null ? SEVERITIES.length : SEVERITIES.indexOf(severity);

// The findings of one result, with stable identities.
export function findingInstances(result: Result): FindingInstance[] {
  const marker = result.marker;
  // Findings are per environment: the same rule on the same page in another
  // environment is another finding. Without environments the ids are as
  // before (the cell is the viewport name).
  const environment = result.environment?.name;
  const cell = environment
    ? `${result.viewport}@${environment}`
    : result.viewport;
  const where = environment ? { environment } : {};
  const norm = (text: string): string =>
    marker ? text.replaceAll(marker, '{{marker}}') : text;
  const out = new Map<string, FindingInstance>();
  const add = (instance: FindingInstance) => {
    const known = out.get(instance.id);
    if (!known) out.set(instance.id, instance);
    else {
      // The same target in two findings of one run (rare): keep the worse.
      if (severityRank(instance.severity) > severityRank(known.severity))
        known.severity = instance.severity;
      if (instance.certainty === 'violation') known.certainty = 'violation';
      known.sampled ||= instance.sampled;
    }
  };
  for (const finding of result.audits.findings) {
    const checkpoint = finding.checkpoints[0]!;
    const measuredURL = finding.reproduction.url;
    const path = pathOf(measuredURL === null ? null : norm(measuredURL));
    const run = result.audits.runs[finding.run];
    const runPath = pathOf(
      run?.checkpoint.url ? norm(run.checkpoint.url) : null,
    );
    const tags = [...new Set(finding.tags.map(norm))].sort();
    const group = [
      'audit',
      result.journey,
      cell,
      finding.auditId,
      finding.ruleId,
      checkpoint,
      path,
      tags,
    ];
    const groupId = hash16(group);
    const targets = finding.targets.length ? finding.targets : [null];
    for (const target of targets) {
      const key = target
        ? target.selector
          ? `selector:${norm(target.selector)}`
          : `description:${withoutDigits(norm(target.description))}`
        : null;
      add({
        id: hash16([...group, key]),
        groupId,
        kind: 'audit',
        journey: result.journey,
        viewport: result.viewport,
        ...where,
        auditId: finding.auditId,
        ruleId: finding.ruleId,
        gateKey: `${finding.auditId}/${finding.ruleId}`,
        checkpoint,
        path,
        tags,
        target: target
          ? { description: target.description, selector: target.selector }
          : null,
        certainty: finding.certainty,
        severity: finding.severity,
        description: finding.description,
        attempts: [result.attempt],
        sampled: finding.nodeCount > finding.targets.length,
        atCheckpoint: path === runPath,
        evidence: {
          screenshot: finding.evidence.screenshot,
          files: finding.evidence.files,
        },
      });
    }
  }
  for (const finding of result.findings) {
    // The placeholder recorded when a run had nothing else to report.
    if (finding.category === 'final-state') continue;
    const instanceId = hash16([
      'finding',
      result.journey,
      cell,
      finding.kind,
      finding.category,
      withoutDigits(norm(finding.description)),
    ]);
    add({
      id: instanceId,
      groupId: instanceId,
      kind: finding.kind,
      journey: result.journey,
      viewport: result.viewport,
      ...where,
      auditId: null,
      ruleId: finding.category,
      gateKey: `finding/${finding.category}`,
      checkpoint: null,
      path: null,
      tags: [],
      target: null,
      certainty: null,
      severity: null,
      description: finding.description,
      attempts: [result.attempt],
      sampled: false,
      atCheckpoint: false,
      evidence: { screenshot: finding.screenshot, files: [] },
    });
  }
  return [...out.values()];
}

// The findings of every result of a run, merged across repeats.
function runInstances(results: Result[]): Map<string, FindingInstance> {
  const merged = new Map<string, FindingInstance>();
  for (const result of results)
    for (const instance of findingInstances(result)) {
      const known = merged.get(instance.id);
      if (!known) {
        merged.set(instance.id, instance);
        continue;
      }
      known.attempts = [...new Set([...known.attempts, ...instance.attempts])];
      if (severityRank(instance.severity) > severityRank(known.severity))
        known.severity = instance.severity;
      if (instance.certainty === 'violation') known.certainty = 'violation';
      known.sampled ||= instance.sampled;
    }
  return merged;
}

// ------------------------------------------------------------- coverage

// Runs pair up per journey, viewport and environment: only like-for-like
// runs are compared.
const pairKey = (journey: string, viewport: string, environment?: string) =>
  `${journey}\u0000${viewport}\u0000${environment ?? ''}`;
const checkKey = (
  journey: string,
  viewport: string,
  environment: string | undefined,
  auditId: string,
  checkpoint: string,
) => [journey, viewport, environment ?? '', auditId, checkpoint].join('\u0000');
// journey/viewport, or journey/environment/viewport.
const cellName = (entry: {
  journey: string;
  viewport: string;
  environment?: string;
}) =>
  entry.environment
    ? `${entry.journey}/${entry.environment}/${entry.viewport}`
    : `${entry.journey}/${entry.viewport}`;

const STATE_RANK: CheckState[] = [
  'assessed',
  'incomplete',
  'error',
  'unsupported',
  'not_reached',
  'not_run',
];

type Coverage = Map<
  string,
  {
    journey: string;
    viewport: string;
    environment?: string;
    auditId: string;
    checkpoint: string;
    state: CheckState;
    // Pages the checkpoint was assessed (or partly assessed) on.
    paths: Set<string | null>;
  }
>;

function coverage(results: Result[]): Coverage {
  const map: Coverage = new Map();
  const note = (
    result: Result,
    auditId: string,
    checkpoint: string,
    state: CheckState,
    path: string | null | undefined,
  ) => {
    const environment = result.environment?.name;
    const key = checkKey(
      result.journey,
      result.viewport,
      environment,
      auditId,
      checkpoint,
    );
    const entry = map.get(key) ?? {
      journey: result.journey,
      viewport: result.viewport,
      ...(environment ? { environment } : {}),
      auditId,
      checkpoint,
      state,
      paths: new Set<string | null>(),
    };
    if (STATE_RANK.indexOf(state) < STATE_RANK.indexOf(entry.state))
      entry.state = state;
    if (path !== undefined && (state === 'assessed' || state === 'incomplete'))
      entry.paths.add(path);
    map.set(key, entry);
  };
  for (const result of results) {
    const norm = (text: string) =>
      result.marker ? text.replaceAll(result.marker, '{{marker}}') : text;
    for (const run of result.audits.runs)
      note(
        result,
        run.auditId,
        run.checkpoint.id,
        run.status === 'clean' || run.status === 'findings'
          ? 'assessed'
          : run.status,
        pathOf(run.checkpoint.url ? norm(run.checkpoint.url) : null),
      );
    for (const missed of result.audits.notReached)
      note(result, missed.auditId, missed.at, 'not_reached', undefined);
  }
  return map;
}

// ------------------------------------------------------------- comparison

const emptyFindings = (): Comparison['findings'] => ({
  new: [],
  persisting: [],
  resolved: [],
  unassessed: [],
});

export function compareRuns(
  base: LoadedRun,
  candidate: LoadedRun,
  gateConfig: Gate,
): Comparison {
  const incompatibilities = [...base.problems, ...candidate.problems];
  const checked =
    base.identity && candidate.identity
      ? compatibility(base.identity, candidate.identity)
      : { incompatibilities: [], warnings: [] };
  incompatibilities.push(...checked.incompatibilities);
  const comparison: Comparison = {
    comparisonVersion: COMPARISON_VERSION,
    engineVersion: ENGINE_VERSION,
    base: { run: base.directory, identity: base.identity },
    candidate: { run: candidate.directory, identity: candidate.identity },
    compatible: !incompatibilities.length,
    incompatibilities,
    warnings: checked.warnings,
    outcomes: [],
    findings: emptyFindings(),
    checks: [],
    counts: {
      new: 0,
      persisting: 0,
      resolved: 0,
      unassessed: 0,
      coverageLost: 0,
    },
    gate: null,
  };
  if (!comparison.compatible || !base.results || !candidate.results)
    return comparison;
  const baseResults = base.results;
  const candidateResults = candidate.results;
  const gate: ResolvedGate = resolveGate(
    gateConfig,
    candidateResults[0]!.audits.failOn,
  );
  const failures: GateFailure[] = [];

  // Functional outcomes per journey/viewport.
  const pairs = new Map<
    string,
    {
      journey: string;
      viewport: string;
      environment?: string;
      base: Result[];
      candidate: Result[];
    }
  >();
  for (const [side, results] of [
    ['base', baseResults],
    ['candidate', candidateResults],
  ] as const)
    for (const result of results) {
      const environment = result.environment?.name;
      const key = pairKey(result.journey, result.viewport, environment);
      const entry = pairs.get(key) ?? {
        journey: result.journey,
        viewport: result.viewport,
        ...(environment ? { environment } : {}),
        base: [],
        candidate: [],
      };
      entry[side].push(result);
      pairs.set(key, entry);
    }
  const side = (results: Result[]) =>
    results.length
      ? {
          runs: results.length,
          passed: results.filter((result) => result.status === 'passed').length,
        }
      : null;
  for (const pair of pairs.values()) {
    const b = side(pair.base);
    const c = side(pair.candidate);
    const regression = !!b && b.passed === b.runs && !!c && c.passed < c.runs;
    comparison.outcomes.push({
      journey: pair.journey,
      viewport: pair.viewport,
      ...(pair.environment ? { environment: pair.environment } : {}),
      base: b,
      candidate: c,
      regression,
    });
    const name = cellName(pair);
    if (b && !c && gate.unassessed === 'fail')
      failures.push({
        code: 'run_missing',
        message: `${name} ran in the base but not in the candidate`,
        finding: null,
      });
    if (c && gate.outcomes === 'any' && c.passed < c.runs)
      failures.push({
        code: 'outcome_not_passed',
        message: `${name} passed ${c.passed}/${c.runs} candidate runs`,
        finding: null,
      });
    else if (regression && gate.outcomes === 'regressions')
      failures.push({
        code: 'outcome_regression',
        message: `${name} passed ${b!.passed}/${b!.runs} base runs and ${c!.passed}/${c!.runs} candidate runs`,
        finding: null,
      });
  }

  // Check coverage on each side.
  const baseCoverage = coverage(baseResults);
  const candidateCoverage = coverage(candidateResults);
  for (const key of new Set([
    ...baseCoverage.keys(),
    ...candidateCoverage.keys(),
  ])) {
    const b = baseCoverage.get(key);
    const c = candidateCoverage.get(key);
    const entry = (b ?? c)!;
    const baseState = b?.state ?? 'not_run';
    const candidateState = c?.state ?? 'not_run';
    const coverageLost =
      baseState === 'assessed' && candidateState !== 'assessed';
    comparison.checks.push({
      journey: entry.journey,
      viewport: entry.viewport,
      ...(entry.environment ? { environment: entry.environment } : {}),
      auditId: entry.auditId,
      checkpoint: entry.checkpoint,
      base: baseState,
      candidate: candidateState,
      coverageLost,
    });
    if (coverageLost && gate.unassessed === 'fail')
      failures.push({
        code: 'coverage_lost',
        message: `${entry.auditId} at ${entry.checkpoint} on ${cellName(entry)} was assessed in the base and is ${candidateState} in the candidate`,
        finding: null,
      });
  }

  // Findings.
  const baseFindings = runInstances(baseResults);
  const candidateFindings = runInstances(candidateResults);
  const candidateGroups = new Map<string, FindingInstance[]>();
  for (const instance of candidateFindings.values())
    candidateGroups.set(instance.groupId, [
      ...(candidateGroups.get(instance.groupId) ?? []),
      instance,
    ]);
  const label = (instance: FindingInstance) =>
    `${instance.gateKey}${instance.severity ? ` (${instance.severity})` : ''} on ${cellName(instance)}${instance.checkpoint ? ` at ${instance.checkpoint}` : ''}${instance.path ? ` ${instance.path}` : ''}${instance.target ? `: ${instance.target.selector ?? instance.target.description}` : ''}`;
  for (const instance of baseFindings.values()) {
    const found = candidateFindings.get(instance.id);
    if (found) {
      const gating = gates(found, gate);
      const escalated = gating && !gates(instance, gate);
      comparison.findings.persisting.push({
        base: instance,
        candidate: found,
        escalated,
        gating: escalated || (gating && gate.persisting),
      });
      if (escalated)
        failures.push({
          code: 'escalated_finding',
          message: `Known finding now gates: ${label(found)} (was ${instance.certainty ?? instance.kind}${instance.severity ? `, ${instance.severity}` : ''})`,
          finding: found.id,
        });
      else if (gating && gate.persisting)
        failures.push({
          code: 'persisting_finding',
          message: `Known finding persists: ${label(found)}`,
          finding: found.id,
        });
      continue;
    }
    const unassessed = whyUnassessed(
      instance,
      pairs.get(
        pairKey(instance.journey, instance.viewport, instance.environment),
      )?.candidate
        .length ?? 0,
      candidateCoverage,
      candidateGroups,
    );
    if (!unassessed) {
      comparison.findings.resolved.push({ base: instance });
      continue;
    }
    const gating = gate.unassessed === 'fail' && gates(instance, gate);
    comparison.findings.unassessed.push({
      base: instance,
      ...unassessed,
      gating,
    });
    if (gating)
      failures.push({
        code: 'unassessed_finding',
        message: `Gating base finding not assessed by the candidate (${unassessed.reason}): ${label(instance)}`,
        finding: instance.id,
      });
  }
  for (const instance of candidateFindings.values()) {
    if (baseFindings.has(instance.id)) continue;
    const gating = gates(instance, gate);
    comparison.findings.new.push({ candidate: instance, gating });
    if (gating)
      failures.push({
        code: 'new_finding',
        message: `New finding: ${label(instance)}`,
        finding: instance.id,
      });
  }
  const order = (a: FindingInstance, b: FindingInstance) =>
    severityRank(b.severity) - severityRank(a.severity) ||
    a.gateKey.localeCompare(b.gateKey) ||
    a.id.localeCompare(b.id);
  comparison.findings.new.sort((a, b) => order(a.candidate, b.candidate));
  comparison.findings.persisting.sort((a, b) =>
    order(a.candidate, b.candidate),
  );
  comparison.findings.resolved.sort((a, b) => order(a.base, b.base));
  comparison.findings.unassessed.sort((a, b) => order(a.base, b.base));
  comparison.counts = {
    new: comparison.findings.new.length,
    persisting: comparison.findings.persisting.length,
    resolved: comparison.findings.resolved.length,
    unassessed: comparison.findings.unassessed.length,
    coverageLost: comparison.checks.filter((check) => check.coverageLost)
      .length,
  };
  comparison.gate = { passed: !failures.length, config: gate, failures };
  return comparison;
}

// Null when the candidate assessed the base finding's check; otherwise why
// its absence proves nothing.
function whyUnassessed(
  instance: FindingInstance,
  candidateRuns: number,
  candidateCoverage: Coverage,
  candidateGroups: Map<string, FindingInstance[]>,
): { reason: UnassessedReason; detail: string } | null {
  if (!candidateRuns)
    return {
      reason: 'run_missing',
      detail: `The candidate did not run ${cellName(instance)}`,
    };
  // A run finding is assessed by the run itself.
  if (instance.kind !== 'audit') return null;
  const check = candidateCoverage.get(
    checkKey(
      instance.journey,
      instance.viewport,
      instance.environment,
      instance.auditId!,
      instance.checkpoint!,
    ),
  );
  if (!check)
    return {
      reason: 'not_run',
      detail: `The candidate did not run ${instance.auditId} at ${instance.checkpoint}`,
    };
  if (check.state !== 'assessed')
    return {
      reason: check.state === 'not_run' ? 'not_run' : check.state,
      detail: `${instance.auditId} at ${instance.checkpoint} is ${check.state} in the candidate`,
    };
  if (instance.atCheckpoint && !check.paths.has(instance.path))
    return {
      reason: 'path_not_assessed',
      detail: `The candidate assessed ${instance.checkpoint} on ${[...check.paths].map((path) => path ?? 'an unknown page').join(', ')}, not ${instance.path ?? 'an unknown page'}`,
    };
  if (candidateGroups.get(instance.groupId)?.some((other) => other.sampled))
    return {
      reason: 'sampled',
      detail: `The candidate still reports ${instance.gateKey} there and sampled other elements`,
    };
  return null;
}

// Exit codes of npm run compare (and of npm run run -- --compare).
export const COMPARE_EXIT = {
  passed: 0,
  gateFailed: 1,
  inputError: 2,
  incompatible: 3,
} as const;

export const comparisonExitCode = (comparison: Comparison): 0 | 1 | 3 =>
  !comparison.compatible ? 3 : comparison.gate?.passed ? 0 : 1;
