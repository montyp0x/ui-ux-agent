// Aggregates a benchmark record and its target results into a report:
// completion with sample size and a 95% Wilson interval, failure classes from
// the result contract's outcome categories, loops, calls, latency, tokens
// (unknown when a provider did not report them, never zero) and optional
// reviewer-labelled finding precision. Model quality and harness correctness
// are reported separately.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { findingInstances } from '../compare.js';
import { parseResults, type OutcomeCode, type Result } from '../results.js';
import type { CallRecord, Stop } from './budget.js';
import type { Ceilings, PinnedModel } from './config.js';
import { benchmarkRecordSchema, type BenchmarkRecord } from './record.js';
import { benchmarkMarkdown } from './report.js';
import { distribution, rate, type Distribution, type Rate } from './stats.js';

// Why a run did not complete, from its outcome (see OUTCOME_CODES).
// interrupted: cut off by a benchmark ceiling or the user; excluded from rates.
export const FAILURE_CLASSES = [
  // Model quality.
  'agent',
  'model',
  'budget',
  // The application's state: an outcome assertion was evaluated and failed.
  'assertion',
  // Harness correctness, environment and unattributed causes.
  'policy',
  'environment',
  'precondition',
  'harness',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export const MODEL_QUALITY_CLASSES = ['agent', 'model', 'budget'] as const;
export const APPLICATION_CLASSES = ['assertion'] as const;
export const HARNESS_CLASSES = [
  'policy',
  'environment',
  'precondition',
  'harness',
  'unknown',
] as const;

export function failureClass(
  result: Pick<Result, 'outcome'>,
): FailureClass | 'passed' | 'interrupted' {
  const { code, category, source } = result.outcome;
  if (code === 'run_cancelled') return 'interrupted';
  if (category === 'passed') return 'passed';
  if (source === 'environment') return 'environment';
  switch (category) {
    case 'agent_loop':
    case 'agent_no_path':
      return 'agent';
    case 'model_error':
      return 'model';
    // Unknown attribution: the agent, a slow model or a slow application.
    case 'budget_exhausted':
      return 'budget';
    case 'assertion_failure':
      return 'assertion';
    case 'policy_block':
    case 'stale_action':
      return 'policy';
    case 'auth_failure':
      return 'environment';
    case 'precondition_failure':
      return 'precondition';
    case 'infrastructure_error':
    case 'cancelled':
      return 'harness';
    default:
      return 'unknown';
  }
}

// --- reviewer labels ------------------------------------------------------

export const LABELS_VERSION = 2;

// Labels name findings by the stable id the run comparison uses
// (findingInstances in src/compare.ts), per benchmark target: one label
// covers every attempt that reported the finding. Version 1 labelled
// per-attempt indexes into findings arrays and is refused.
export const labelsSchema = z
  .object({
    labelsVersion: z.literal(LABELS_VERSION, {
      error: () =>
        `labelsVersion ${LABELS_VERSION} is required: label each finding by its stable id (benchmark-report.json precision.items), not by attempt and index as version 1 did`,
    }),
    reviewer: z.string().min(1),
    labels: z.array(
      z
        .object({
          target: z.string().min(1),
          // findingInstances(result).id: 16 hex characters.
          id: z.string().regex(/^[0-9a-f]{16}$/),
          // confirmed: the reviewer reproduced it as a real issue.
          verdict: z.enum(['confirmed', 'rejected']),
          note: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type Labels = z.infer<typeof labelsSchema>;

type FindingKind = 'hypothesis' | 'observed' | 'audit';
const FINDING_KINDS: FindingKind[] = ['hypothesis', 'observed', 'audit'];

export type KindPrecision = {
  total: number;
  labelled: number;
  unlabelled: number;
  confirmed: number;
  rejected: number;
  // confirmed / labelled.
  precision: Rate;
};
export type Precision = {
  // unknown: no reviewer labels; precision is not assumed.
  status: 'unknown' | 'measured';
  reason: string;
  reviewer: string | null;
  file: string | null;
  // Distinct findings per kind across all targets (a finding reported in
  // several attempts of a target counts once).
  findings: Record<FindingKind, number>;
  byKind: Partial<Record<FindingKind, KindPrecision>>;
  // Every distinct finding, to label by its id. Identifiers only: no
  // finding text (read it in the target's results.json or a comparison).
  items: PrecisionItem[];
};
export type PrecisionItem = {
  target: string;
  id: string;
  kind: FindingKind;
  journey: string;
  viewport: string;
  // The audit rule, or the finding category.
  ruleId: string;
  auditId: string | null;
  // Attempts (repeat numbers) that reported it.
  attempts: number[];
  verdict: 'confirmed' | 'rejected' | null;
};

// --- report shape ---------------------------------------------------------

export type Tokens = {
  // Unknown when any request's usage was not reported.
  input: number | 'unknown';
  output: number | 'unknown';
  reportedCalls: number;
  unknownCalls: number;
  // Reported tokens only.
  lowerBound: { input: number; output: number };
};
type RoleCalls = {
  dispatched: number;
  completed: number;
  usageUnknown: number;
};
export type Calls = {
  // Requests sent, retries included.
  dispatched: number;
  // Requests with a response the adapter accepted.
  completed: number;
  byRole: { planner: RoleCalls; selector: RoleCalls };
};
export type Loops = {
  runsEndedByLoop: number;
  // loop_check events: a revisit replanned, a third visit rejected.
  replans: number;
  rejected: number;
};
export type RunStats = {
  results: number;
  interrupted: number;
  evaluated: number;
  // Passed among evaluated runs.
  completion: Rate;
  // Passed among evaluated runs not stopped by the harness, environment or
  // application (only passes and model-quality failures).
  modelCompletion: Rate;
  failures: Record<FailureClass, number>;
  codes: Partial<Record<OutcomeCode, number>>;
  loops: Loops;
  stepsPerRun: Distribution;
  durationMsPerRun: Distribution;
  callsPerRun: Distribution;
};
export type CellSummary = RunStats & {
  journey: string;
  viewport: string;
};
export type Aggregate = RunStats & {
  planned: number;
  notStarted: number;
  calls: Calls;
  tokens: Tokens;
  latency: { planner: Distribution; selector: Distribution };
};
// One run's model usage: its requests (retries included), tokens (unknown
// when any of its requests' usage was not reported, never zero) and latency.
export type RunTotals = {
  journey: string;
  viewport: string;
  attempt: number;
  // The run's outcome code; null when it left no result (it was interrupted
  // before one was written, or its session never opened).
  outcome: OutcomeCode | null;
  calls: Calls;
  tokens: Tokens;
  latency: { planner: Distribution; selector: Distribution };
  // Summed latency of the run's answered requests, per role.
  latencyTotalMs: { planner: number; selector: number };
};
export type TargetSummary = Aggregate & {
  id: string;
  suite: string;
  suiteName: string;
  sha256: string;
  journey: string | null;
  viewport: string | null;
  reviewed: { by: string; on: string };
  started: boolean;
  error: string | null;
  cells: CellSummary[];
  // Per-run totals, in start order; empty for records written before calls
  // were attributed to runs.
  runs: RunTotals[];
  // Answered calls the record attributes to no run (older records).
  unattributedCalls: number;
};
export type BenchmarkReport = {
  benchmarkVersion: 1;
  name: string;
  mode: 'live' | 'fixture';
  notice: string;
  configuration: {
    configPath: string;
    configSha256: string;
    engine: BenchmarkRecord['engine'];
    model: PinnedModel;
    overriddenEnv: string[];
    repeat: number;
    ceilings: Ceilings;
  };
  startedAt: string;
  finishedAt: string;
  wallTimeMs: number;
  stop: Stop | null;
  thresholds: { status: 'not_defined'; note: string };
  overall: Aggregate;
  targets: TargetSummary[];
  modelQuality: {
    completion: Rate;
    failures: Record<(typeof MODEL_QUALITY_CLASSES)[number], number>;
    loops: Loops;
    latency: Aggregate['latency'];
    tokens: Tokens;
    callsPerRun: Distribution;
  };
  application: {
    failures: Record<(typeof APPLICATION_CLASSES)[number], number>;
  };
  harness: {
    // Every results.json validated against the result contract.
    resultsValid: boolean;
    // Per-run usage the runner recorded matches the benchmark's call log.
    usageReconciled: boolean;
    reconciliation: {
      target: string;
      runnerCalls: number;
      recordedCalls: number;
      runnerTokens: number;
      recordedTokens: number;
    }[];
    dispatchWithinCeiling: boolean;
    // Requests sent without an accepted response (failed, timed out,
    // aborted or rate-limited); their usage is unknown.
    unansweredRequests: number;
    interrupted: number;
    notStarted: number;
    targetErrors: { target: string; error: string }[];
    failures: Record<(typeof HARNESS_CLASSES)[number], number>;
  };
  precision: Precision;
};

// --- aggregation ----------------------------------------------------------

type LoopEvents = Map<string, { replans: number; rejected: number }>;
const cellKey = (journey: string, viewport: string) =>
  `${journey}\u0000${viewport}`;

const zeroFailures = (): Record<FailureClass, number> =>
  Object.fromEntries(FAILURE_CLASSES.map((name) => [name, 0])) as Record<
    FailureClass,
    number
  >;
const pick = <K extends FailureClass>(
  failures: Record<FailureClass, number>,
  keys: readonly K[],
): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, failures[key]])) as Record<
    K,
    number
  >;

function runStats(results: Result[], loops: LoopEvents): RunStats {
  const failures = zeroFailures();
  const codes: RunStats['codes'] = {};
  let passed = 0;
  let interrupted = 0;
  const evaluated: Result[] = [];
  for (const result of results) {
    const kind = failureClass(result);
    codes[result.outcome.code] = (codes[result.outcome.code] ?? 0) + 1;
    if (kind === 'interrupted') {
      interrupted++;
      continue;
    }
    evaluated.push(result);
    if (kind === 'passed') passed++;
    else failures[kind]++;
  }
  const outside = [...HARNESS_CLASSES, ...APPLICATION_CLASSES].reduce(
    (sum, key) => sum + failures[key],
    0,
  );
  const cells = new Set(
    results.map((result) => cellKey(result.journey, result.viewport)),
  );
  const loopEvents = [...cells].reduce(
    (sum, key) => ({
      replans: sum.replans + (loops.get(key)?.replans ?? 0),
      rejected: sum.rejected + (loops.get(key)?.rejected ?? 0),
    }),
    { replans: 0, rejected: 0 },
  );
  return {
    results: results.length,
    interrupted,
    evaluated: evaluated.length,
    completion: rate(passed, evaluated.length),
    modelCompletion: rate(passed, evaluated.length - outside),
    failures,
    codes,
    loops: {
      runsEndedByLoop: codes.repeated_action ?? 0,
      ...loopEvents,
    },
    stepsPerRun: distribution(evaluated.map((result) => result.steps)),
    durationMsPerRun: distribution(
      evaluated.map((result) => result.durationMs),
    ),
    callsPerRun: distribution(
      evaluated.map(
        (result) => result.usage.planner.calls + result.usage.selector.calls,
      ),
    ),
  };
}

const known = (call: CallRecord) =>
  call.inputTokens !== null && call.outputTokens !== null;

function callStats(
  calls: CallRecord[],
  dispatched: { planner: number; selector: number },
): Pick<Aggregate, 'calls' | 'tokens' | 'latency'> {
  const role = (name: 'planner' | 'selector'): RoleCalls => {
    const mine = calls.filter((call) => call.role === name);
    return {
      dispatched: dispatched[name],
      completed: mine.length,
      usageUnknown: dispatched[name] - mine.filter(known).length,
    };
  };
  const total = dispatched.planner + dispatched.selector;
  const reported = calls.filter(known).length;
  const lowerBound = {
    input: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    output: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
  };
  const unknownCalls = total - reported;
  return {
    calls: {
      dispatched: total,
      completed: calls.length,
      byRole: { planner: role('planner'), selector: role('selector') },
    },
    tokens: {
      input: unknownCalls ? 'unknown' : lowerBound.input,
      output: unknownCalls ? 'unknown' : lowerBound.output,
      reportedCalls: reported,
      unknownCalls,
      lowerBound,
    },
    latency: {
      planner: distribution(
        calls.filter((c) => c.role === 'planner').map((c) => c.durationMs),
      ),
      selector: distribution(
        calls.filter((c) => c.role === 'selector').map((c) => c.durationMs),
      ),
    },
  };
}

const sameRun = (
  a: { journey: string; viewport: string; attempt: number },
  b: { journey: string; viewport: string; attempt: number },
) =>
  a.journey === b.journey &&
  a.viewport === b.viewport &&
  a.attempt === b.attempt;

function runTotals(
  target: BenchmarkRecord['targets'][number],
  calls: CallRecord[],
  results: Result[],
): RunTotals[] {
  return target.runs.map((run) => {
    const mine = calls.filter((call) => call.run && sameRun(call.run, run));
    const total = (role: 'planner' | 'selector') =>
      mine
        .filter((call) => call.role === role)
        .reduce((sum, call) => sum + call.durationMs, 0);
    return {
      journey: run.journey,
      viewport: run.viewport,
      attempt: run.attempt,
      outcome:
        results.find((result) => sameRun(result, run))?.outcome.code ?? null,
      ...callStats(mine, run.dispatched),
      latencyTotalMs: {
        planner: total('planner'),
        selector: total('selector'),
      },
    };
  });
}

const refKey = (target: string, id: string) => `${target}\u0000${id}`;

function precision(
  results: Map<string, Result[]>,
  labels: { file: string; labels: Labels } | null,
): Precision {
  const refs = new Map<string, PrecisionItem>();
  for (const [target, list] of results)
    for (const result of list)
      for (const instance of findingInstances(result)) {
        const key = refKey(target, instance.id);
        const known = refs.get(key);
        if (known) {
          if (!known.attempts.includes(result.attempt))
            known.attempts = [...known.attempts, result.attempt].sort(
              (a, b) => a - b,
            );
          continue;
        }
        refs.set(key, {
          target,
          id: instance.id,
          kind: instance.kind,
          journey: instance.journey,
          viewport: instance.viewport,
          ruleId: instance.ruleId,
          auditId: instance.auditId,
          attempts: [result.attempt],
          verdict: null,
        });
      }
  const items = [...refs.values()];
  const findings = Object.fromEntries(
    FINDING_KINDS.map((kind) => [
      kind,
      items.filter((ref) => ref.kind === kind).length,
    ]),
  ) as Record<FindingKind, number>;
  if (!labels)
    return {
      status: 'unknown',
      reason: 'No reviewer labels file was given; finding precision is unknown',
      reviewer: null,
      file: null,
      findings,
      byKind: {},
      items,
    };
  const verdicts = new Map<string, 'confirmed' | 'rejected'>();
  for (const label of labels.labels.labels) {
    const key = refKey(label.target, label.id);
    const ref = refs.get(key);
    if (!ref)
      throw new Error(
        `Label refers to no finding: ${label.target} finding ${label.id}`,
      );
    if (verdicts.has(key))
      throw new Error(`Duplicate label: ${label.target} finding ${label.id}`);
    verdicts.set(key, label.verdict);
    ref.verdict = label.verdict;
  }
  const byKind: Precision['byKind'] = {};
  for (const kind of FINDING_KINDS) {
    if (!findings[kind]) continue;
    let confirmed = 0;
    let rejected = 0;
    for (const [key, ref] of refs) {
      if (ref.kind !== kind) continue;
      const verdict = verdicts.get(key);
      if (verdict === 'confirmed') confirmed++;
      else if (verdict === 'rejected') rejected++;
    }
    byKind[kind] = {
      total: findings[kind],
      labelled: confirmed + rejected,
      unlabelled: findings[kind] - confirmed - rejected,
      confirmed,
      rejected,
      precision: rate(confirmed, confirmed + rejected),
    };
  }
  return {
    status: 'measured',
    reason: `${verdicts.size} of ${refs.size} findings labelled by ${labels.labels.reviewer}`,
    reviewer: labels.labels.reviewer,
    file: labels.file,
    findings,
    byKind,
    items,
  };
}

export type BenchmarkData = {
  record: BenchmarkRecord;
  // Per target id: its results.json (empty when it never ran).
  results: Map<string, Result[]>;
  // Per target id: loop_check event counts per journey/viewport.
  loops: Map<string, LoopEvents>;
  labels: { file: string; labels: Labels } | null;
};

export function aggregateBenchmark(data: BenchmarkData): BenchmarkReport {
  const { record } = data;
  const targets: TargetSummary[] = record.targets.map((target) => {
    const results = data.results.get(target.id) ?? [];
    const loops = data.loops.get(target.id) ?? new Map();
    const cells = new Map<string, Result[]>();
    for (const result of results) {
      const key = cellKey(result.journey, result.viewport);
      cells.set(key, [...(cells.get(key) ?? []), result]);
    }
    const calls = record.calls.filter((call) => call.target === target.id);
    return {
      id: target.id,
      suite: target.suite,
      suiteName: target.suiteName,
      sha256: target.sha256,
      journey: target.journey,
      viewport: target.viewport,
      reviewed: target.reviewed,
      started: target.started,
      error: target.error,
      planned: target.planned,
      notStarted: target.planned - results.length,
      ...runStats(results, loops),
      ...callStats(calls, target.dispatched),
      cells: [...cells.values()].map((list) => ({
        journey: list[0]!.journey,
        viewport: list[0]!.viewport,
        ...runStats(list, loops),
      })),
      runs: runTotals(target, calls, results),
      unattributedCalls: calls.filter((call) => !call.run).length,
    };
  });
  const allResults = record.targets.flatMap(
    (target) => data.results.get(target.id) ?? [],
  );
  // Loop events are keyed by journey/viewport within a target, so the overall
  // count sums the targets.
  const overallStats = runStats(allResults, new Map());
  overallStats.loops = {
    runsEndedByLoop: overallStats.loops.runsEndedByLoop,
    replans: targets.reduce((sum, target) => sum + target.loops.replans, 0),
    rejected: targets.reduce((sum, target) => sum + target.loops.rejected, 0),
  };
  const dispatched = record.targets.reduce(
    (sum, target) => ({
      planner: sum.planner + target.dispatched.planner,
      selector: sum.selector + target.dispatched.selector,
    }),
    { planner: 0, selector: 0 },
  );
  const planned = record.targets.reduce((sum, t) => sum + t.planned, 0);
  const overall: Aggregate = {
    planned,
    notStarted: planned - allResults.length,
    ...overallStats,
    ...callStats(record.calls, dispatched),
  };
  const reconciliation = targets.map((target) => {
    const results = data.results.get(target.id) ?? [];
    const calls = record.calls.filter((call) => call.target === target.id);
    return {
      target: target.id,
      runnerCalls: results.reduce(
        (sum, r) => sum + r.usage.planner.calls + r.usage.selector.calls,
        0,
      ),
      recordedCalls: calls.length,
      runnerTokens: results.reduce(
        (sum, r) =>
          sum +
          r.usage.planner.inputTokens +
          r.usage.planner.outputTokens +
          r.usage.selector.inputTokens +
          r.usage.selector.outputTokens,
        0,
      ),
      recordedTokens: calls.reduce(
        (sum, c) => sum + (c.inputTokens ?? 0) + (c.outputTokens ?? 0),
        0,
      ),
    };
  });
  return {
    benchmarkVersion: 1,
    name: record.name,
    mode: record.mode,
    notice:
      record.mode === 'fixture'
        ? 'Fixture run: model responses came from a local fake server. This is harness verification, not a live model measurement.'
        : 'Live model run with the pinned configuration below. Results describe this configuration on these targets only.',
    configuration: {
      configPath: record.configPath,
      configSha256: record.configSha256,
      engine: record.engine,
      model: record.model,
      overriddenEnv: record.overriddenEnv,
      repeat: record.repeat,
      ceilings: record.ceilings,
    },
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    wallTimeMs: record.wallTimeMs,
    stop: record.stop,
    thresholds: {
      status: 'not_defined',
      note: 'No release thresholds are defined yet. Target-specific thresholds are set only after a baseline of repeated live runs has been collected and reviewed.',
    },
    overall,
    targets,
    modelQuality: {
      completion: overall.modelCompletion,
      failures: pick(overall.failures, MODEL_QUALITY_CLASSES),
      loops: overall.loops,
      latency: overall.latency,
      tokens: overall.tokens,
      callsPerRun: overall.callsPerRun,
    },
    application: { failures: pick(overall.failures, APPLICATION_CLASSES) },
    harness: {
      resultsValid: true,
      usageReconciled: reconciliation.every(
        (entry) =>
          entry.runnerCalls === entry.recordedCalls &&
          entry.runnerTokens === entry.recordedTokens,
      ),
      reconciliation,
      dispatchWithinCeiling:
        overall.calls.dispatched <= record.ceilings.maxModelCalls,
      unansweredRequests: overall.calls.dispatched - overall.calls.completed,
      interrupted: overall.interrupted,
      notStarted: overall.notStarted,
      targetErrors: targets.flatMap((target) =>
        target.error ? [{ target: target.id, error: target.error }] : [],
      ),
      failures: pick(overall.failures, HARNESS_CLASSES),
    },
    precision: precision(data.results, data.labels),
  };
}

// --- disk -----------------------------------------------------------------

const loopEventSchema = z.object({
  event: z.literal('loop_check'),
  data: z.object({
    journey: z.string(),
    viewport: z.string(),
    outcome: z.enum(['dispatch', 'replan', 'rejected']),
  }),
});

async function loopEvents(directory: string): Promise<LoopEvents> {
  const loops: LoopEvents = new Map();
  const path = join(directory, 'events.jsonl');
  if (!existsSync(path)) return loops;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.includes('"loop_check"')) continue;
    const parsed = loopEventSchema.safeParse(JSON.parse(line));
    if (!parsed.success) continue;
    const key = cellKey(parsed.data.data.journey, parsed.data.data.viewport);
    const entry = loops.get(key) ?? { replans: 0, rejected: 0 };
    if (parsed.data.data.outcome === 'replan') entry.replans++;
    if (parsed.data.data.outcome === 'rejected') entry.rejected++;
    loops.set(key, entry);
  }
  return loops;
}

// Rebuilds the report of a finished benchmark directory, optionally with a
// reviewer labels file. Makes no model call.
export async function loadBenchmarkReport(
  directory: string,
  labelsPath?: string,
): Promise<BenchmarkReport> {
  const root = resolve(directory);
  const record = benchmarkRecordSchema.parse(
    JSON.parse(await readFile(join(root, 'benchmark.json'), 'utf8')),
  );
  const results = new Map<string, Result[]>();
  const loops = new Map<string, LoopEvents>();
  for (const target of record.targets) {
    const dir = join(root, target.directory);
    const file = join(dir, 'results.json');
    // parseResults validates every result against the result contract.
    results.set(
      target.id,
      existsSync(file) ? parseResults(await readFile(file, 'utf8')) : [],
    );
    loops.set(target.id, await loopEvents(dir));
  }
  const labels = labelsPath
    ? {
        file: resolve(labelsPath),
        labels: labelsSchema.parse(
          JSON.parse(await readFile(resolve(labelsPath), 'utf8')),
        ),
      }
    : null;
  return aggregateBenchmark({ record, results, loops, labels });
}

export async function writeBenchmarkReport(
  directory: string,
  report: BenchmarkReport,
): Promise<void> {
  await writeFile(
    join(directory, 'benchmark-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'benchmark-report.md'),
    benchmarkMarkdown(report),
    { mode: 0o600 },
  );
}
