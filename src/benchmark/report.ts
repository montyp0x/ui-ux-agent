// Markdown rendering of a benchmark report. Every rate is shown with its
// sample size and 95% Wilson interval; unknown usage is shown as unknown.
import type { BenchmarkReport, Tokens } from './aggregate.js';
import type { Distribution, Rate } from './stats.js';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatRate(value: Rate): string {
  if (value.n === 0 || value.rate === null || !value.interval)
    return 'n = 0 (no evaluated runs)';
  return `${value.successes}/${value.n} = ${percent(value.rate)} (n = ${value.n}; 95% Wilson ${percent(value.interval.low)}–${percent(value.interval.high)})`;
}

const ms = (value: number | null) =>
  value === null ? '–' : `${Math.round(value)} ms`;
const formatDistribution = (value: Distribution, unit = ms) =>
  value.n
    ? `n = ${value.n}, median ${unit(value.median)}, p90 ${unit(value.p90)}, max ${unit(value.max)}`
    : 'n = 0';
const count = (value: number | null) => (value === null ? '–' : String(value));

function formatTokens(tokens: Tokens): string {
  const total =
    tokens.input === 'unknown' || tokens.output === 'unknown'
      ? `unknown (${tokens.unknownCalls} request(s) without reported usage; reported so far: ${tokens.lowerBound.input} input, ${tokens.lowerBound.output} output)`
      : `${tokens.input} input, ${tokens.output} output`;
  return total;
}

// A run's tokens in a table cell: unknown, with the reported lower bound,
// when any of its requests' usage was not reported.
function tokenCell(tokens: Tokens): string {
  return tokens.input === 'unknown' || tokens.output === 'unknown'
    ? `unknown (≥ ${tokens.lowerBound.input} in, ${tokens.lowerBound.output} out; ${tokens.unknownCalls} without usage)`
    : `${tokens.input} in, ${tokens.output} out`;
}

// Model and URL text from the config is shown verbatim; escape table pipes.
const cell = (value: string) => value.replaceAll('|', '\\|');

export function benchmarkMarkdown(report: BenchmarkReport): string {
  const { configuration: config, overall } = report;
  const lines: string[] = [];
  const add = (...more: string[]) => lines.push(...more);
  add(
    `# Benchmark: ${report.name}`,
    '',
    `> ${report.notice}`,
    '',
    `Mode: **${report.mode}**. Started ${report.startedAt}, finished ${report.finishedAt} (${(report.wallTimeMs / 1000).toFixed(1)} s).`,
    '',
    report.stop
      ? `**Stopped early: ${report.stop.reason}** after ${(report.stop.atMs / 1000).toFixed(1)} s — ${report.stop.detail}. The run in progress is counted as interrupted and excluded from rates; ${overall.notStarted} planned run(s) did not start.`
      : 'Completed without reaching a ceiling.',
    '',
    `**Thresholds:** ${report.thresholds.note}`,
    '',
    '## Configuration',
    '',
    `- Config: \`${config.configPath}\` (sha256 \`${config.configSha256}\`)`,
    `- Planner: \`${cell(config.model.plannerModel)}\` at ${cell(config.model.plannerURL)}`,
    `- Selector: \`${cell(config.model.selectorModel)}\` (${config.model.selectorProtocol}) at ${cell(config.model.selectorURL)}`,
    `- Rate limits: planner ${config.model.plannerRateLimit ? `${config.model.plannerRateLimit.rpm} rpm / ${config.model.plannerRateLimit.concurrency}` : 'engine default'}, selector ${config.model.selectorRateLimit ? `${config.model.selectorRateLimit.rpm} rpm / ${config.model.selectorRateLimit.concurrency}` : 'engine default'}`,
    `- Repeat: ${config.repeat} per journey/viewport`,
    `- Ceilings: ${config.ceilings.maxModelCalls} model requests, ${config.ceilings.maxTokens} tokens, ${config.ceilings.maxWallTimeMs} ms wall time; unknown usage: ${config.ceilings.unknownUsage}`,
    `- Engine: result contract v${config.engine.resultVersion}, audit contract v${config.engine.auditContractVersion}, revision ${config.engine.gitRevision ?? 'unknown'}${config.engine.gitDirty ? ' (uncommitted changes)' : ''}, Node ${config.engine.node}, ${config.engine.platform}`,
    ...(config.overriddenEnv.length
      ? [
          `- Pinned values overrode environment variables: ${config.overriddenEnv.join(', ')}`,
        ]
      : []),
    '',
    '### Targets',
    '',
    '| Target | Suite | sha256 | Scope | Reviewed | Planned | Ran | Interrupted | Not started |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.targets.map(
      (target) =>
        `| ${cell(target.id)} | ${cell(target.suiteName)} (\`${cell(target.suite)}\`) | \`${target.sha256.slice(0, 12)}\` | ${cell(target.journey ?? 'all journeys')} / ${cell(target.viewport ?? 'all viewports')} | ${cell(target.reviewed.by)}, ${target.reviewed.on} | ${target.planned} | ${target.results} | ${target.interrupted} | ${target.notStarted} |`,
    ),
    '',
    '## Model quality',
    '',
    'Runs stopped by the harness, the environment or a failed application assertion are excluded here; see Harness correctness.',
    '',
    `- Completion (model-attributable): ${formatRate(report.modelQuality.completion)}`,
    `- Completion (all evaluated runs): ${formatRate(overall.completion)}`,
    `- Failures: agent ${report.modelQuality.failures.agent} (loops, no path), model ${report.modelQuality.failures.model} (call failed, invalid output), budget ${report.modelQuality.failures.budget} (step/time budget; attribution unknown)`,
    `- Loops: ${report.modelQuality.loops.runsEndedByLoop} run(s) ended by a repeated action; ${report.modelQuality.loops.replans} revisit replan(s), ${report.modelQuality.loops.rejected} rejected repeat(s)`,
    `- Planner latency: ${formatDistribution(report.modelQuality.latency.planner)}`,
    `- Selector latency: ${formatDistribution(report.modelQuality.latency.selector)}`,
    `- Model calls per evaluated run: ${formatDistribution(report.modelQuality.callsPerRun, count)}`,
    `- Tokens: ${formatTokens(report.modelQuality.tokens)}`,
    `- Model requests: ${overall.calls.dispatched} sent (planner ${overall.calls.byRole.planner.dispatched}, selector ${overall.calls.byRole.selector.dispatched}), ${overall.calls.completed} answered; usage unknown for planner ${overall.calls.byRole.planner.usageUnknown}, selector ${overall.calls.byRole.selector.usageUnknown}`,
    '',
    'Latency is measured around each adapter call and includes client-side rate-limit waits.',
    '',
    '| Target | Journey | Viewport | Completion (model-attributable) | Completion (all) | agent | model | budget |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.targets.flatMap((target) =>
      target.cells.map(
        (row) =>
          `| ${cell(target.id)} | ${cell(row.journey)} | ${cell(row.viewport)} | ${formatRate(row.modelCompletion)} | ${formatRate(row.completion)} | ${row.failures.agent} | ${row.failures.model} | ${row.failures.budget} |`,
      ),
    ),
    '',
    '### Per run',
    '',
    'Requests sent (retries included) and answered, tokens and summed latency of each run.',
    '',
    '| Target | Journey | Viewport | Attempt | Outcome | Requests (sent/answered) | Tokens | Planner latency | Selector latency |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.targets.flatMap((target) =>
      target.runs.map(
        (row) =>
          `| ${cell(target.id)} | ${cell(row.journey)} | ${cell(row.viewport)} | ${row.attempt} | ${row.outcome ?? 'no result'} | ${row.calls.dispatched}/${row.calls.completed} | ${tokenCell(row.tokens)} | ${ms(row.latencyTotalMs.planner)} (${row.latency.planner.n}) | ${ms(row.latencyTotalMs.selector)} (${row.latency.selector.n}) |`,
      ),
    ),
    ...report.targets.flatMap((target) =>
      target.unattributedCalls
        ? [
            '',
            `Target ${cell(target.id)}: ${target.unattributedCalls} answered request(s) not attributed to runs (recorded before per-run attribution); per-run totals are unavailable for them.`,
          ]
        : [],
    ),
    '',
    '## Application outcome',
    '',
    `- Failed outcome assertions: ${report.application.failures.assertion}`,
    '',
    '## Harness correctness',
    '',
    `- Results valid against the result contract: ${report.harness.resultsValid ? 'yes' : 'no'}`,
    `- Per-run usage reconciles with the call log: ${report.harness.usageReconciled ? 'yes' : 'NO'}`,
    `- Requests within maxModelCalls: ${report.harness.dispatchWithinCeiling ? 'yes' : 'NO'} (${overall.calls.dispatched}/${config.ceilings.maxModelCalls})`,
    `- Requests without an accepted response: ${report.harness.unansweredRequests}`,
    `- Failures: policy ${report.harness.failures.policy} (scope or request policy, stale actions), environment ${report.harness.failures.environment} (auth, test data), precondition ${report.harness.failures.precondition} (readiness or setup), harness ${report.harness.failures.harness} (driver, evidence, cleanup), unknown ${report.harness.failures.unknown}`,
    `- Interrupted by a ceiling or the user: ${report.harness.interrupted}; not started: ${report.harness.notStarted}`,
    ...report.harness.targetErrors.map(
      (entry) => `- Target ${cell(entry.target)} did not run: ${entry.error}`,
    ),
    '',
    'The deterministic test suite (`npm test`) is what verifies harness behaviour; the lines above only check this run’s bookkeeping.',
    '',
    '## Finding precision (human review)',
    '',
    `Findings: ${report.precision.findings.hypothesis} model hypotheses, ${report.precision.findings.observed} observed, ${report.precision.findings.audit} audit.`,
    '',
  );
  if (report.precision.status === 'unknown')
    add(`Precision: unknown. ${report.precision.reason}.`);
  else {
    add(
      `Labelled by ${report.precision.reviewer} (\`${report.precision.file}\`): ${report.precision.reason}.`,
      '',
    );
    for (const [kind, entry] of Object.entries(report.precision.byKind))
      add(
        `- ${kind}: precision ${formatRate(entry.precision)}; ${entry.unlabelled} of ${entry.total} unlabelled`,
      );
  }
  if (report.precision.items.length)
    add(
      '',
      'Label findings by target and id (`labelsVersion: 2`); the finding text is in each target’s `results.json`.',
      '',
      '| Target | Id | Kind | Journey / viewport | Rule | Attempts | Verdict |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...report.precision.items.map(
        (item) =>
          `| ${cell(item.target)} | \`${item.id}\` | ${item.kind} | ${cell(item.journey)} / ${cell(item.viewport)} | ${cell(item.auditId ? `${item.auditId}/${item.ruleId}` : item.ruleId)} | ${item.attempts.join(', ')} | ${item.verdict ?? 'unlabelled'} |`,
      ),
    );
  add('');
  return lines.join('\n');
}
