import { relative, sep } from 'node:path';
import type { Result } from './contracts.js';
import { summarize } from './summary.js';

export function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}

export function reportHTML(
  name: string,
  results: Result[],
  directory: string,
): string {
  const link = (file: string) =>
    escapeHTML(relative(directory, file).split(sep).join('/'));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(name)}</title>
<style>table{border-collapse:collapse;background:white;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}body{font:16px system-ui;margin:40px auto;max-width:1080px;padding:0 20px;color:#20252b;background:#f4f5f7}article{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}img{width:100%;border:1px solid #ddd}h1,h2{line-height:1.2}a{color:#2255ac}code{overflow-wrap:anywhere}small{color:#596574}.passed{color:#176339}.failed,.error{color:#a12727}.blocked{color:#895700}</style>
<h1>${escapeHTML(name)}</h1><p>${results.filter((result) => result.status === 'passed').length}/${results.length} runs reached their asserted outcome. Model concerns require human review. These runs are synthetic task probes, not measured human usability.</p>
<table><thead><tr><th>Journey</th><th>Viewport</th><th>Passed</th><th>Other outcomes</th><th>Median actions</th><th>Median duration</th><th>Model calls (planner / selector)</th><th>Tokens (in / out)</th></tr></thead><tbody>${summarize(
    results,
  )
    .map(
      (row) =>
        `<tr><td>${escapeHTML(row.journey)}</td><td>${escapeHTML(row.viewport)}</td><td>${row.passed}/${row.runs}</td><td>${escapeHTML(
          Object.entries(row.reasons)
            .map(([reason, count]) => `${count}× ${reason}`)
            .join('; ') || '—',
        )}</td><td>${row.medianSteps}</td><td>${(row.medianDurationMs / 1000).toFixed(1)}s</td><td>${row.modelCalls.planner} / ${row.modelCalls.selector}</td><td>${row.tokens.input} / ${row.tokens.output}</td></tr>`,
    )
    .join('')}</tbody></table>
${results
  .map(
    (
      result,
    ) => `<article><h2>${escapeHTML(result.journey)} · ${escapeHTML(result.viewport)}${result.attempt > 1 || results.some((other) => other !== result && other.journey === result.journey && other.viewport === result.viewport) ? ` · run ${result.attempt}` : ''}</h2><p class="${result.status}"><strong>${result.status.toUpperCase()}</strong> ${escapeHTML(result.reason)}</p><p>${result.steps} actions · ${(result.durationMs / 1000).toFixed(1)} seconds · ${result.usage.planner.calls + result.usage.selector.calls} model calls, ${result.usage.planner.inputTokens + result.usage.selector.inputTokens} input / ${result.usage.planner.outputTokens + result.usage.selector.outputTokens} output tokens · checks: ${result.checks.map((ok) => (ok ? 'pass' : 'fail')).join(', ') || 'not evaluated'}</p><p><a href="${link(result.trace)}">Local Playwright trace</a>${result.video ? ` · <a href="${link(result.video)}">Video</a>` : ''}</p>
${result.findings.map((finding) => `<details><summary>${escapeHTML(finding.kind)} / ${escapeHTML(finding.category)} / step ${finding.step}</summary><p>${escapeHTML(finding.description)}</p><a href="${link(finding.screenshot)}"><img src="${link(finding.screenshot)}" alt="Evidence at step ${finding.step}" loading="lazy"></a></details>`).join('')}
</article>`,
  )
  .join(
    '',
  )}<p>Raw observations, decisions, and execution outcomes: <code>events.jsonl</code>. Screenshots, videos and traces may contain private organization data and session material; keep this run local.</p></html>`;
}
