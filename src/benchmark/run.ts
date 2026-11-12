// Runs a benchmark: every target suite through the existing runner with its
// repeat support, one model adapter for the whole benchmark whose requests
// the budget meters, and a record (benchmark.json) the report is aggregated
// from. A live run needs an explicit opt-in and never runs under the Node test
// runner; a fixture run only talks to loopback model endpoints.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_CONTRACT_VERSION } from '../audits/contract.js';
import { dedicatedProfile } from '../auth.js';
import { suiteEvidencePolicy } from '../contracts.js';
import type { UIDriver } from '../drivers/types.js';
import { Redactor } from '../evidence/redact.js';
import { models, type ModelOptions } from '../models.js';
import { RESULT_VERSION } from '../results.js';
import { runSuite } from '../runner.js';
import {
  BENCHMARK_VERSION,
  plannedRuns,
  type LoadedBenchmark,
  type ResolvedTarget,
} from './config.js';
import { BenchmarkBudget, type Stop } from './budget.js';
import { benchmarkRecordSchema, type BenchmarkRecord } from './record.js';
import {
  loadBenchmarkReport,
  writeBenchmarkReport,
  type BenchmarkReport,
} from './aggregate.js';

export const LIVE_OPT_IN_ENV = 'UIUX_LIVE_BENCHMARK';

type Env = Record<string, string | undefined>;

// A live benchmark spends real model calls: it needs the --live flag and
// UIUX_LIVE_BENCHMARK=1, and is refused inside the Node test runner, so the
// normal deterministic suite can never start one.
export function assertLiveOptIn(input: { flag: boolean; env: Env }): void {
  if (input.env.NODE_TEST_CONTEXT !== undefined)
    throw new Error(
      'Live benchmarks never run under the Node test runner (NODE_TEST_CONTEXT is set)',
    );
  if (!input.flag)
    throw new Error(
      'A live benchmark makes paid model calls: pass --live to confirm',
    );
  if (input.env[LIVE_OPT_IN_ENV] !== '1')
    throw new Error(
      `A live benchmark makes paid model calls: set ${LIVE_OPT_IN_ENV}=1 to opt in`,
    );
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const isLoopback = (url: string) => {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

export type BenchmarkOptions = {
  mode: 'live' | 'fixture';
  // Required for mode live (see assertLiveOptIn).
  optIn?: { flag: boolean; env: Env };
  // Must match the config's pinned model (see pinnedModelOptions).
  modelOptions: ModelOptions;
  overriddenEnv?: string[];
  // A new directory; target runs go in <directory>/<target id>.
  directory: string;
  // Tests inject a driver per target; otherwise the suite's own driver.
  driver?: (target: ResolvedTarget) => UIDriver;
  headless?: boolean;
  env?: Env;
  // Cancels the benchmark (Ctrl-C), recorded as stop reason cancelled.
  signal?: AbortSignal;
  progress?: (line: string) => void;
};

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function assertPinned(loaded: LoadedBenchmark, options: ModelOptions): void {
  const model = loaded.config.model;
  const mismatched = (
    [
      ['plannerURL', options.plannerURL, model.plannerURL],
      ['plannerModel', options.plannerModel, model.plannerModel],
      [
        'selectorProtocol',
        options.selectorProtocol ?? 'typesafe',
        model.selectorProtocol,
      ],
      ['selectorURL', options.selectorURL, model.selectorURL],
      ['selectorModel', options.selectorModel, model.selectorModel],
    ] as const
  ).filter(([, actual, pinned]) => actual !== pinned);
  if (mismatched.length)
    throw new Error(
      `Model options differ from the pinned configuration: ${mismatched.map(([name]) => name).join(', ')}`,
    );
}

export async function runBenchmark(
  loaded: LoadedBenchmark,
  options: BenchmarkOptions,
): Promise<{ record: BenchmarkRecord; report: BenchmarkReport }> {
  if (options.mode === 'live') {
    assertLiveOptIn(options.optIn ?? { flag: false, env: {} });
    // Also checked on the real process, so an injected env cannot bypass it.
    if (process.env.NODE_TEST_CONTEXT !== undefined)
      throw new Error(
        'Live benchmarks never run under the Node test runner (NODE_TEST_CONTEXT is set)',
      );
  }
  assertPinned(loaded, options.modelOptions);
  if (
    options.mode === 'fixture' &&
    !(
      isLoopback(options.modelOptions.plannerURL) &&
      isLoopback(options.modelOptions.selectorURL)
    )
  )
    throw new Error(
      'A fixture benchmark only talks to loopback model endpoints',
    );
  const { config } = loaded;
  const env = options.env ?? process.env;
  const redactor = new Redactor({ env });
  const directory = resolve(options.directory);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  // Not recursive: a benchmark directory is never reused.
  await mkdir(directory, { mode: 0o700 });

  const budget = new BenchmarkBudget(config.ceilings);
  const onCancel = () => budget.cancel('cancelled by the user');
  if (options.signal?.aborted) onCancel();
  else options.signal?.addEventListener('abort', onCancel, { once: true });
  const startedAt = new Date().toISOString();
  const targets: BenchmarkRecord['targets'] = [];
  budget.start();
  try {
    for (const target of loaded.targets) {
      // The suite's own patterns and secret variables too, as the runner
      // redacts its evidence; setup values never reach this record.
      const suiteRedactor = new Redactor({
        patterns: target.parsed.evidence.redact,
        envNames: suiteEvidencePolicy(target.parsed).redactEnv,
        env,
      });
      const entry: BenchmarkRecord['targets'][number] = {
        id: target.id,
        suite: target.suite,
        suiteName: suiteRedactor.text(target.parsed.name),
        sha256: target.sha256,
        journey: target.journey ?? null,
        viewport: target.viewport ?? null,
        reviewed: target.reviewed,
        directory: target.id,
        planned: plannedRuns(target, config.repeat),
        started: false,
        error: null,
        dispatched: { planner: 0, selector: 0 },
      };
      targets.push(entry);
      if (budget.stop) continue;
      budget.target = target.id;
      entry.started = true;
      options.progress?.(
        `Target ${target.id}: ${entry.planned} runs of ${target.suite}`,
      );
      const base = dirname(loaded.path);
      try {
        await runSuite(
          target.parsed,
          (log) =>
            models({
              ...options.modelOptions,
              beforeDispatch: (data) => budget.beforeDispatch(data),
              onCall: async (data) => {
                budget.recordCall(data);
                await log('model_call', data);
              },
              onWait: (data) => log('model_wait', data),
            }),
          {
            directory: join(directory, target.id),
            journey: target.journey,
            viewport: target.viewport,
            repeat: config.repeat,
            headless: options.headless ?? true,
            driver: options.driver?.(target),
            storageState: target.storageState
              ? resolve(base, target.storageState)
              : undefined,
            profile: target.profile
              ? await dedicatedProfile(resolve(base, target.profile))
              : undefined,
            env,
            signal: budget.signal,
          },
        );
      } catch (caught) {
        entry.error = suiteRedactor.text(
          (caught instanceof Error ? caught.message : String(caught)).split(
            '\n',
          )[0]!,
        );
        options.progress?.(`Target ${target.id} did not run: ${entry.error}`);
      }
      entry.dispatched = {
        ...(budget.dispatchedByTarget.get(target.id) ?? {
          planner: 0,
          selector: 0,
        }),
      };
      // Read again: runSuite may have stopped the budget.
      const stop = budget.stop as Stop | null;
      if (stop) options.progress?.(`Stopped: ${stop.reason} (${stop.detail})`);
    }
  } finally {
    budget.dispose();
    options.signal?.removeEventListener('abort', onCancel);
  }
  const revision = git(['rev-parse', 'HEAD']);
  const status = revision
    ? git(['status', '--porcelain', '--untracked-files=no'])
    : null;
  const record = benchmarkRecordSchema.parse({
    benchmarkVersion: BENCHMARK_VERSION,
    mode: options.mode,
    name: redactor.text(config.name),
    configPath: loaded.path,
    configSha256: loaded.sha256,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallTimeMs: budget.elapsedMs,
    engine: {
      resultVersion: RESULT_VERSION,
      auditContractVersion: AUDIT_CONTRACT_VERSION,
      gitRevision: revision,
      gitDirty: status === null ? null : status.length > 0,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    model: config.model,
    overriddenEnv: options.overriddenEnv ?? [],
    repeat: config.repeat,
    ceilings: config.ceilings,
    stop: budget.stop,
    targets,
    calls: budget.calls,
  } satisfies BenchmarkRecord);
  await writeFile(
    join(directory, 'benchmark.json'),
    JSON.stringify(record, null, 2) + '\n',
    { mode: 0o600 },
  );
  const report = await loadBenchmarkReport(directory);
  await writeBenchmarkReport(directory, report);
  return { record, report };
}
