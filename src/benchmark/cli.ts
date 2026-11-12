// npm run benchmark -- ...
//   --config PATH --validate            check the config and print its bounds (no model call)
//   --config PATH --live [--env-file PATH] [--out DIR] [--headed]
//                                       run it; needs UIUX_LIVE_BENCHMARK=1 (paid model calls)
//   --report DIR [--labels PATH]        rebuild a finished benchmark's report (no model call)
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Redactor } from '../evidence/redact.js';
import { loadBenchmark, pinnedModelOptions, plannedRuns } from './config.js';
import { loadBenchmarkReport, writeBenchmarkReport } from './aggregate.js';
import { formatRate } from './report.js';
import { assertLiveOptIn, LIVE_OPT_IN_ENV, runBenchmark } from './run.js';

const HELP = `npm run benchmark -- --config benchmark.json --validate
${LIVE_OPT_IN_ENV}=1 npm run benchmark -- --config benchmark.json --live [--env-file PATH] [--out DIR] [--headed]
npm run benchmark -- --report DIR [--labels labels.json]

A live benchmark makes paid model calls, bounded by the config's required ceilings
(maxModelCalls, maxTokens, maxWallTimeMs). Credentials come from the environment
or an explicit --env-file; ./.env is not read. See docs/benchmark.md.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      live: { type: 'boolean' },
      validate: { type: 'boolean' },
      report: { type: 'string' },
      labels: { type: 'string' },
      out: { type: 'string' },
      'env-file': { type: 'string' },
      headed: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.report) {
    const report = await loadBenchmarkReport(values.report, values.labels);
    await writeBenchmarkReport(resolve(values.report), report);
    console.log(
      `${report.mode} benchmark ${report.name}: completion ${formatRate(report.overall.completion)}`,
    );
    console.log(`Report: ${resolve(values.report, 'benchmark-report.md')}`);
    return 0;
  }
  if (!values.config) throw new Error('--config is required (see --help)');
  if (values.validate) {
    const loaded = await loadBenchmark(values.config);
    const { config } = loaded;
    console.log(`Valid benchmark: ${config.name}`);
    for (const target of loaded.targets)
      console.log(
        `  ${target.id}: ${target.suite} (sha256 ${target.sha256}), ${plannedRuns(target, config.repeat)} runs, reviewed by ${target.reviewed.by} on ${target.reviewed.on}`,
      );
    console.log(
      `Bounds: at most ${config.ceilings.maxModelCalls} model requests; ` +
        `stops once reported tokens reach ${config.ceilings.maxTokens} (it can pass that by one response); ` +
        `at ${config.ceilings.maxWallTimeMs} ms wall time it aborts in-flight requests, sends no more and cancels the run in progress (its data cleanup still runs). ` +
        `Unknown usage: ${config.ceilings.unknownUsage}.`,
    );
    return 0;
  }
  // Refuse before reading credentials or launching anything.
  assertLiveOptIn({ flag: !!values.live, env: process.env });
  const loaded = await loadBenchmark(values.config);
  if (values['env-file']) {
    process.loadEnvFile(resolve(values['env-file']));
    console.log(`Loaded environment from ${resolve(values['env-file'])}`);
  }
  const { options, overridden } = pinnedModelOptions(
    loaded.config.model,
    process.env,
  );
  if (overridden.length)
    console.log(
      `Pinned model configuration overrides: ${overridden.join(', ')}`,
    );
  const directory = resolve(
    values.out ??
      `runs/benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  const cancel = new AbortController();
  process.once('SIGINT', () => {
    console.error(
      'Cancelling: the current run cleans up and no further run starts (Ctrl-C again to exit now)',
    );
    cancel.abort();
    process.once('SIGINT', () => process.exit(130));
  });
  const { report } = await runBenchmark(loaded, {
    mode: 'live',
    optIn: { flag: !!values.live, env: process.env },
    modelOptions: options,
    overriddenEnv: overridden,
    directory,
    headless: !values.headed,
    signal: cancel.signal,
    progress: (line) => console.log(line),
  });
  console.log(`Completion: ${formatRate(report.overall.completion)}`);
  if (report.stop)
    console.log(`Stopped early: ${report.stop.reason} (${report.stop.detail})`);
  console.log(`Report: ${directory}/benchmark-report.md`);
  // A benchmark measures; it does not gate. Exit 0 once a report is written.
  return 0;
}

try {
  process.exitCode = await main();
} catch (caught) {
  // Errors can quote configuration or provider text: redact credentials.
  console.error(
    new Redactor({ env: process.env }).text(
      caught instanceof Error ? caught.message : String(caught),
    ),
  );
  process.exitCode = 2;
}
