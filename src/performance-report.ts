// HTML for performance.web: the per-run measurement table (src/report.ts)
// and the performance section of a run comparison (src/compare-report.ts).
// App metrics and harness time are shown in separate rows; nothing is
// combined into a score.
import type { AuditRun } from './audits/contract.js';
import {
  PERFORMANCE_METRICS,
  type PerformanceMeasurement,
  type PerformanceMetric,
} from './audits/performance-contract.js';
import type { PerformanceComparison } from './compare.js';

const LABEL: Record<PerformanceMetric, string> = {
  ttfbMs: 'Time to first byte',
  fcpMs: 'First contentful paint',
  lcpMs: 'Largest contentful paint',
  cls: 'Cumulative layout shift',
  inpMs: 'Interaction to next paint',
  domContentLoadedMs: 'DOMContentLoaded',
  loadMs: 'Load event',
  blockingTimeMs: 'Blocking time (long tasks over 50 ms)',
};

const value = (metric: PerformanceMetric, number: number | null): string =>
  number === null
    ? 'not measured'
    : metric === 'cls'
      ? String(number)
      : `${Math.round(number)} ms`;

const conditions = (measurement: PerformanceMeasurement): string => {
  const { network, networkProfile, cpuSlowdown } = measurement.conditions;
  const parts = [
    network
      ? `network ${networkProfile ?? 'custom'} (${network.latencyMs} ms latency, ${network.downloadKbps}/${network.uploadKbps} kbps)`
      : 'network unthrottled',
    cpuSlowdown !== null ? `CPU ${cpuSlowdown}x slower` : 'CPU unthrottled',
  ];
  return `${measurement.browser} · ${parts.join(' · ')}`;
};

export function performanceHTML(
  runs: AuditRun[],
  escape: (value: string) => string,
): string {
  const measured = runs.filter(
    (run): run is AuditRun & { performance: PerformanceMeasurement } =>
      !!run.performance,
  );
  if (!measured.length) return '';
  const item = (run: (typeof measured)[number]) => {
    const measurement = run.performance;
    const budgets = new Map(
      measurement.budgets.map((budget) => [budget.metric, budget]),
    );
    const rows = PERFORMANCE_METRICS.map((metric) => {
      const budget = budgets.get(metric);
      const unsupported = measurement.unsupported.includes(metric);
      return `<tr><td>${LABEL[metric]}</td><td>${unsupported ? 'not reported by this browser' : value(metric, measurement.metrics[metric])}</td><td>${budget ? `${escape(budget.status)} (max ${value(metric, budget.max)}, ${escape(budget.severity)})` : ''}</td></tr>`;
    }).join('');
    const harness = measurement.harness;
    const interactions = measurement.interactions;
    const slowest = interactions.slowest
      .map(
        (entry) =>
          `${escape(entry.type)} on ${escape(entry.target ?? 'removed element')} ${Math.round(entry.durationMs)} ms (input delay ${Math.round(entry.inputDelayMs)}, processing ${Math.round(entry.processingMs)}, presentation ${Math.round(entry.presentationMs)})${entry.selected ? '' : ' · not selected'}`,
      )
      .join('; ');
    return `<section><p><code>${escape(run.checkpoint.id)}</code> · <code>${escape(measurement.document.path || '/')}</code> · ${escape(conditions(measurement))}${measurement.conditions.applied ? '' : ' · <strong>conditions not applied</strong>'}</p><table><thead><tr><th>App metric (browser timestamps)</th><th>Value</th><th>Budget</th></tr></thead><tbody>${rows}</tbody></table><p><small>${measurement.lcpElement ? `LCP element <code>${escape(measurement.lcpElement)}</code> · ` : ''}${interactions.count} interaction(s), ${interactions.selected} selected${slowest ? `; slowest: ${slowest}` : ''} · long tasks: ${measurement.longTasks.app.count} app, ${measurement.longTasks.duringHarness.count} while another audit ran (${Math.round(measurement.longTasks.duringHarness.blockingMs)} ms blocking, not counted) · left out while another audit ran: ${measurement.excludedDuringHarness.layoutShifts} shift(s), ${measurement.excludedDuringHarness.lcpCandidates} LCP candidate(s), ${measurement.excludedDuringHarness.interactions} interaction(s)</small></p><p><small>Harness time, not in the metrics above: ${harness ? `${(harness.elapsedMs / 1000).toFixed(1)} s journey so far · ${harness.modelCalls} model call(s) ${(harness.modelMs / 1000).toFixed(1)} s · ${harness.screenshots} screenshot(s) ${(harness.screenshotMs / 1000).toFixed(1)} s · earlier audits ${(harness.auditMs / 1000).toFixed(1)} s` : 'not tracked'} · document age at measurement ${(measurement.document.ageMs / 1000).toFixed(1)} s</small></p></section>`;
  };
  return `<h3>Performance</h3><p><small>One measurement per checkpoint under the listed conditions; compare repeated runs with the same conditions, not single values. No overall score.</small></p>${measured.map(item).join('')}`;
}

export function performanceComparisonHTML(
  entries: PerformanceComparison[],
  escape: (value: string) => string,
): string {
  if (!entries.length) return '';
  const side = (stats: PerformanceComparison['base'], metric: PerformanceMetric) =>
    stats
      ? `${value(metric, stats.median)}${stats.samples > 1 ? ` <small>median of ${stats.samples} (${value(metric, stats.min)}–${value(metric, stats.max)})</small>` : ''}`
      : 'not measured';
  const rows = entries
    .map(
      (entry) =>
        `<tr><td>${escape(`${entry.journey}/${entry.viewport}`)}</td><td>${escape(entry.checkpoint)} <code>${escape(entry.path || '/')}</code></td><td>${LABEL[entry.metric]}</td><td>${side(entry.base, entry.metric)}</td><td>${side(entry.candidate, entry.metric)}</td><td>${entry.status === 'compared' ? `${entry.delta! > 0 ? '+' : ''}${entry.metric === 'cls' ? entry.delta : `${Math.round(entry.delta!)} ms`}` : `<strong>${escape(entry.status)}</strong>${entry.reason ? `<br><small>${escape(entry.reason)}</small>` : ''}`}</td></tr>`,
    )
    .join('');
  return `<h2>Performance</h2><p><small>Medians per journey, viewport, checkpoint, page and metric, compared only under the same conditions and browser. Timing varies between runs: read small deltas with the sample ranges. Budget breaches are findings above; there is no overall score.</small></p><table><thead><tr><th>Journey/viewport</th><th>Checkpoint</th><th>Metric</th><th>Base</th><th>Candidate</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`;
}
