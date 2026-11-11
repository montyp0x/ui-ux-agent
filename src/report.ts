import { relative, sep } from 'node:path';
import type { Quality, Result } from './results.js';
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

const VERDICT_LABEL: Record<Quality['verdict'], string> = {
  pass: 'QUALITY PASS',
  fail: 'QUALITY FAIL',
  not_evaluated: 'QUALITY NOT EVALUATED',
};

export function reportHTML(
  name: string,
  results: Result[],
  directory: string,
): string {
  const link = (file: string) =>
    escapeHTML(relative(directory, file).split(sep).join('/'));
  const verdicts = { pass: 0, fail: 0, not_evaluated: 0 };
  for (const result of results) verdicts[result.quality.verdict]++;
  const outcome = (result: Result) => {
    const { outcome } = result;
    const evidence = [
      `step ${outcome.step}`,
      `stage ${outcome.stage}`,
      outcome.evidence.failedChecks.length
        ? `false checks ${outcome.evidence.failedChecks.join(', ')}`
        : '',
      outcome.evidence.events.length
        ? `events ${outcome.evidence.events.join(', ')}`
        : '',
      outcome.detail ? `detail: ${outcome.detail}` : '',
    ].filter(Boolean);
    const signals = Object.entries(outcome.signals)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => `${key} ${value}`);
    return `<p class="${result.status}"><strong>${result.status.toUpperCase()}</strong> ${escapeHTML(result.reason)}</p><p><small>Outcome <code>${escapeHTML(outcome.code)}</code> · ${escapeHTML(outcome.category)} · source ${escapeHTML(outcome.source)}${result.status !== 'passed' && outcome.source !== 'assertion' ? ' · not by itself evidence of a product defect' : ''} · ${escapeHTML(evidence.join(' · '))}${outcome.evidence.screenshot ? ` · <a href="${link(outcome.evidence.screenshot)}">deciding screenshot</a>` : ''}${signals.length ? ` · run signals: ${escapeHTML(signals.join(', '))}` : ''}</small></p>`;
  };
  const quality = ({ quality }: Result) =>
    `<p class="quality-${quality.verdict}"><strong>${VERDICT_LABEL[quality.verdict]}</strong> ${escapeHTML(quality.reason)}</p><details><summary>Quality coverage: ${quality.executed.length} executed, ${quality.skipped.length} skipped, ${quality.unsupported.length} unsupported</summary><ul>${[
      ...quality.executed.map(
        (check) =>
          `<li><code>${escapeHTML(check.id)}</code> ${escapeHTML(check.status)} over ${check.observations} observed states${check.findings.length ? ` (findings ${check.findings.map((index) => index + 1).join(', ')})` : ''}${check.detail ? `: ${escapeHTML(check.detail)}` : ''}</li>`,
      ),
      ...quality.skipped.map(
        (gap) =>
          `<li><code>${escapeHTML(gap.id)}</code> skipped: ${escapeHTML(gap.reason)}</li>`,
      ),
      ...quality.unsupported.map(
        (gap) =>
          `<li><code>${escapeHTML(gap.id)}</code> unsupported: ${escapeHTML(gap.reason)}</li>`,
      ),
    ].join('')}</ul></details>`;
  // Audits that actually ran somewhere (not unsupported, not errored).
  const scanned = [
    ...new Set(
      results.flatMap((result) =>
        result.audits.runs
          .filter(
            (run) => run.status !== 'unsupported' && run.status !== 'error',
          )
          .map((run) => run.auditId),
      ),
    ),
  ];
  // Audit runs per checkpoint, then violations and needs-review items apart.
  const audits = ({ audits, outcome, durationMs }: Result) => {
    if (!audits.runs.length && !audits.notReached.length) return '';
    const finding = (index: number) => {
      const entry = audits.findings[index]!;
      const targets = entry.targets
        .map(
          (target) =>
            `<li>${escapeHTML(target.description)}${target.selector ? ` <code>${escapeHTML(target.selector)}</code>` : ''}${target.reason ? ` · ${escapeHTML(target.reason)}` : ''}${target.snippet ? `<br><code>${escapeHTML(target.snippet)}</code>` : ''}</li>`,
        )
        .join('');
      return `<li><strong>${escapeHTML(entry.severity ?? 'unknown severity')}</strong>${entry.gating ? ' · fails quality' : ''} · <code>${escapeHTML(entry.ruleId)}</code> · ${escapeHTML(entry.reproduction.checkpoint)} step ${entry.reproduction.step}${entry.reproduction.url ? ` · ${escapeHTML(entry.reproduction.url)}` : ''}: ${escapeHTML(entry.description)}${entry.tags.length ? ` <small>${escapeHTML(entry.tags.join(', '))}</small>` : ''}${entry.helpUrl ? ` · <a href="${escapeHTML(entry.helpUrl)}">guidance</a>` : ''}${entry.evidence.screenshot ? ` · <a href="${link(entry.evidence.screenshot)}">screenshot</a>` : ''}${entry.nodeCount > entry.targets.length ? ` <small>(${entry.targets.length} of ${entry.nodeCount} elements shown)</small>` : ''}${targets ? `<ul>${targets}</ul>` : ''}</li>`;
    };
    const indices = audits.findings.map((_, index) => index);
    const violations = indices.filter(
      (index) => audits.findings[index]!.certainty === 'violation',
    );
    const review = indices.filter(
      (index) => audits.findings[index]!.certainty === 'needs_review',
    );
    const runs = audits.runs
      .map(
        (run) =>
          `<li><code>${escapeHTML(run.auditId)}</code> at <code>${escapeHTML(run.checkpoint.id)}</code> (step ${run.checkpoint.step}): <strong class="audit-${run.status}">${escapeHTML(run.status)}</strong> · ${run.durationMs} ms${run.analyzer ? ` · ${escapeHTML(run.analyzer.name)}${run.analyzer.version ? ` ${escapeHTML(run.analyzer.version)}` : ''}` : ''}${run.findings.length ? ` · ${run.findings.length} finding(s)` : ''}${run.detail ? `: ${escapeHTML(run.detail)}` : ''}${run.limitations.length ? `<br><small>Limitations: ${escapeHTML(run.limitations.join('; '))}</small>` : ''}${run.exemptions.length ? `<br><small>Exempted by configuration (${run.exemptions.length}): ${escapeHTML(run.exemptions.map((item) => `${item.ruleId} ${item.target.description}${item.target.selector ? ` ${item.target.selector}` : ''}: ${item.reason}`).join('; '))}</small>` : ''}</li>`,
      )
      .join('');
    const notReached = audits.notReached
      .map(
        (gap) =>
          `<li><code>${escapeHTML(gap.auditId)}</code> at <code>${escapeHTML(gap.at)}</code>: checkpoint not reached</li>`,
      )
      .join('');
    // Audit time counts against the journey deadline; shown so a slow scan
    // is visible as the cause of an exhausted budget.
    const auditMs = audits.runs.reduce((total, run) => total + run.durationMs, 0);
    const budgetNote =
      outcome.category === 'budget_exhausted' && auditMs > 0
        ? `<p><small>Audits took ${(auditMs / 1000).toFixed(1)} s of this run's ${(durationMs / 1000).toFixed(1)} s (${Math.round((auditMs / Math.max(1, durationMs)) * 100)}%); audit time counts against the journey deadline.</small></p>`
        : '';
    return `${budgetNote}<details><summary>Audits: ${audits.runs.length} run(s), ${violations.length} violation(s), ${review.length} needing manual review · ${(auditMs / 1000).toFixed(1)} s audit time · fail on ${escapeHTML(audits.failOn)}</summary><ul>${runs}${notReached}</ul>${violations.length ? `<h3>Audit violations</h3><ul>${violations.map(finding).join('')}</ul>` : ''}${review.length ? `<h3>Needs manual review</h3><p><small>Not counted in the quality verdict.</small></p><ul>${review.map(finding).join('')}</ul>` : ''}</details>`;
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(name)}</title>
<style>table{border-collapse:collapse;background:white;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}body{font:16px system-ui;margin:40px auto;max-width:1080px;padding:0 20px;color:#20252b;background:#f4f5f7}article{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}img{width:100%;border:1px solid #ddd}h1,h2{line-height:1.2}a{color:#2255ac}code{overflow-wrap:anywhere}small{color:#596574}.passed,.quality-pass{color:#176339}.failed,.error,.quality-fail{color:#a12727}.blocked{color:#895700}.quality-not_evaluated{color:#596574}.audit-findings,.audit-error{color:#a12727}.audit-incomplete,.audit-unsupported{color:#895700}.audit-clean{color:#176339}</style>
<h1>${escapeHTML(name)}</h1><p>${results.filter((result) => result.status === 'passed').length}/${results.length} runs reached their asserted outcome. Quality verdicts, kept separate from that outcome: ${verdicts.pass} pass, ${verdicts.fail} fail, ${verdicts.not_evaluated} not evaluated (not evaluated is not a pass). Model concerns require human review. These runs are synthetic task probes, not measured human usability.${scanned.length ? ` Automated audits ran at configured checkpoints (${escapeHTML(scanned.join(', '))}); an automated scan does not establish accessibility or standards conformance.` : ' No automated audit ran; this is not an accessibility audit.'}</p>
<table><thead><tr><th>Journey</th><th>Viewport</th><th>Passed</th><th>Other outcomes</th><th>Quality (pass / fail / not evaluated)</th><th>Median actions</th><th>Median duration</th><th>Model calls (planner / selector)</th><th>Tokens (in / out)</th></tr></thead><tbody>${summarize(
    results,
  )
    .map(
      (row) =>
        `<tr><td>${escapeHTML(row.journey)}</td><td>${escapeHTML(row.viewport)}</td><td>${row.passed}/${row.runs}</td><td>${escapeHTML(
          [
            ...Object.entries(row.categories).map(
              ([category, count]) => `${count}× ${category}`,
            ),
            ...Object.entries(row.reasons).map(
              ([reason, count]) => `${count}× ${reason}`,
            ),
          ].join('; ') || '—',
        )}</td><td>${row.quality.pass} / ${row.quality.fail} / ${row.quality.not_evaluated}</td><td>${row.medianSteps}</td><td>${(row.medianDurationMs / 1000).toFixed(1)}s</td><td>${row.modelCalls.planner} / ${row.modelCalls.selector}</td><td>${row.tokens.input} / ${row.tokens.output}</td></tr>`,
    )
    .join('')}</tbody></table>
${results
  .map(
    (
      result,
    ) => `<article><h2>${escapeHTML(result.journey)} · ${escapeHTML(result.viewport)}${result.attempt > 1 || results.some((other) => other !== result && other.journey === result.journey && other.viewport === result.viewport) ? ` · run ${result.attempt}` : ''}</h2>${outcome(result)}${quality(result)}${audits(result)}<p>${result.steps} actions · ${(result.durationMs / 1000).toFixed(1)} seconds · ${result.usage.planner.calls + result.usage.selector.calls} model calls, ${result.usage.planner.inputTokens + result.usage.selector.inputTokens} input / ${result.usage.planner.outputTokens + result.usage.selector.outputTokens} output tokens · outcome checks: ${result.checks.map((ok) => (ok ? 'pass' : 'fail')).join(', ') || 'not evaluated'}</p><p><a href="${link(result.trace)}">${result.trace.endsWith('.json') ? 'Final accessibility tree' : 'Local Playwright trace'}</a>${result.video ? ` · <a href="${link(result.video)}">Video</a>` : ''}</p>
${result.findings.map((finding, index) => `<details><summary>${index + 1}. ${escapeHTML(finding.kind)} / ${escapeHTML(finding.category)} / step ${finding.step}</summary><p>${escapeHTML(finding.description)}</p><a href="${link(finding.screenshot)}"><img src="${link(finding.screenshot)}" alt="Evidence at step ${finding.step}" loading="lazy"></a></details>`).join('')}
</article>`,
  )
  .join(
    '',
  )}<p>Raw observations, decisions, and execution outcomes: <code>events.jsonl</code>. Screenshots, videos and traces may contain private organization data and session material; keep this run local.</p></html>`;
}
