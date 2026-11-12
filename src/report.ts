import { relative, sep } from 'node:path';
import type { AuditRun } from './audits/contract.js';
import type {
  VisualComparison,
  VisualStatus,
} from './audits/visual-contract.js';
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

const VISUAL_LABEL: Record<VisualStatus, string> = {
  match: 'MATCH',
  mismatch: 'MISMATCH',
  missing: 'NO APPROVED BASELINE (not a pass)',
  incompatible: 'INCOMPATIBLE BASELINE (not compared, not a pass)',
  unstable: 'UNSTABLE CAPTURE (not compared, not a pass)',
};

// Baseline, current and diff images of each visual.baseline run, with the
// aggregate and per-region difference, or why nothing was compared.
function visualHTML(runs: AuditRun[], link: (file: string) => string): string {
  const visual = runs.flatMap((run) => (run.visual ? [run.visual] : []));
  if (!visual.length) return '';
  const figure = (label: string, file: string | null | undefined) =>
    file
      ? `<figure style="margin:0;flex:1;min-width:200px"><figcaption><small>${label}</small></figcaption><a href="${link(file)}"><img src="${link(file)}" alt="${label}" loading="lazy"></a></figure>`
      : `<figure style="margin:0;flex:1;min-width:200px"><figcaption><small>${label}: none</small></figcaption></figure>`;
  const item = (entry: VisualComparison) => {
    const { pixels, tolerance } = entry;
    const aggregate = pixels
      ? `${pixels.diff} of ${pixels.total} pixels differ (${(pixels.ratio * 100).toFixed(3)}%)${pixels.sizeChanged ? ' · image size changed' : ''} · tolerance ${tolerance.maxDiffPixels} pixels and ${(tolerance.maxDiffRatio * 100).toFixed(3)}% at colour threshold ${tolerance.threshold}`
      : 'not compared';
    const regions = entry.regions.length
      ? `<table><thead><tr><th>Region (x, y, width × height)</th><th>Changed pixels</th></tr></thead><tbody>${entry.regions.map((region) => `<tr><td>${region.x}, ${region.y}, ${region.width} × ${region.height}</td><td>${region.diffPixels}</td></tr>`).join('')}</tbody></table>${entry.regionCount > entry.regions.length ? `<p><small>${entry.regions.length} of ${entry.regionCount} regions shown.</small></p>` : ''}`
      : '';
    const incompatible = entry.incompatible.length
      ? `<table><thead><tr><th>Environment field</th><th>Approved baseline</th><th>This run</th></tr></thead><tbody>${entry.incompatible.map((field) => `<tr><td><code>${escapeHTML(field.field)}</code></td><td>${escapeHTML(field.baseline)}</td><td>${escapeHTML(field.current)}</td></tr>`).join('')}</tbody></table>`
      : '';
    const env = entry.environment;
    const masks = entry.masks.length
      ? ` · masks ${escapeHTML(entry.masks.map((mask) => `${mask.selector} (${mask.matched})`).join(', '))}`
      : '';
    return `<section><p><strong class="visual-${entry.status}">${VISUAL_LABEL[entry.status]}</strong> <code>${escapeHTML(entry.key.checkpoint)}</code> · ${escapeHTML(aggregate)}${entry.baseline ? ` · baseline approved ${escapeHTML(entry.baseline.approvedAt)}` : ''}</p><p><small>Environment <code>${entry.environmentId}</code>: ${escapeHTML(`${env.browser.name} ${env.browser.version}${env.browser.headless ? ' headless' : ''} (${env.browser.build}) · ${env.os.platform}-${env.os.arch} ${env.os.release} · ${env.viewport.width}×${env.viewport.height} @${env.deviceScaleFactor} · ${env.locale} · ${env.timezone} · ${env.colorScheme}${env.capture.fullPage ? ' · full page' : ''}${env.capture.protected ? ' · evidence protection applied' : ''}`)}${masks} · ${entry.captures} captures</small></p>${incompatible}${regions}<div style="display:flex;gap:8px;flex-wrap:wrap">${figure('Approved baseline', entry.baseline?.file)}${figure('Current', entry.current?.file)}${figure('Diff (red: changed, blue: darker now)', entry.diff)}</div></section>`;
  };
  return `<h3>Visual comparisons</h3><p><small>Captures are never approved by a run; review the current image, then approve it with <code>npm run baseline -- approve</code>.</small></p>${visual.map(item).join('')}`;
}

const VERDICT_LABEL: Record<Quality['verdict'], string> = {
  pass: 'QUALITY PASS',
  fail: 'QUALITY FAIL',
  not_evaluated: 'QUALITY NOT EVALUATED',
};

// `href` maps a recorded evidence path to a link relative to the run
// directory; the runner passes evidenceLinks (src/evidence/links.ts), which
// also resolves paths the run's redaction rewrote. Without it, links are the
// recorded paths relative to `directory`.
export function reportHTML(
  name: string,
  results: Result[],
  directory: string,
  href: (file: string) => string = (file) =>
    relative(directory, file).split(sep).join('/'),
): string {
  const link = (file: string) => escapeHTML(href(file));
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
  // Data lifecycle hooks of authorized write flows. A failed cleanup is shown
  // at the top of the report and on its run, whatever the run's outcome.
  const unclean = results.filter(
    (result) => result.dataLifecycle && !result.dataLifecycle.clean,
  );
  const cleanupBanner = unclean.length
    ? `<p class="cleanup-failed" role="alert"><strong>CLEANUP FAILED</strong> for ${unclean.length} of ${results.length} run(s): test data may remain on ${escapeHTML([...new Set(unclean.map((result) => result.dataLifecycle!.service))].join(', '))}. Runs: ${escapeHTML(unclean.map((result) => `${result.journey}/${result.viewport} (run ${result.dataLifecycle!.run})`).join('; '))}. Clean it up before the next run.</p>`
    : '';
  const hook = (
    name: string,
    record: { status: string; durationMs: number; detail: string | null } | null,
  ) =>
    record
      ? `${name} <strong class="hook-${record.status}">${escapeHTML(record.status)}</strong> (${record.durationMs} ms${record.detail ? `: ${escapeHTML(record.detail)}` : ''})`
      : '';
  const dataLifecycle = ({ dataLifecycle: data }: Result) =>
    data
      ? `<p${data.clean ? '' : ' class="cleanup-failed"'}><small>Data lifecycle on ${escapeHTML(data.service)} for run <code>${escapeHTML(data.run)}</code>: ${[
          hook('reset', data.reset),
          hook('setup', data.setup),
          data.values.length
            ? `values ${escapeHTML(data.values.join(', '))}`
            : '',
          data.cleanup
            ? `${hook('cleanup', data.cleanup)} after ${escapeHTML(data.cleanup.trigger)}${data.cleanup.remaining !== null ? `, ${data.cleanup.remaining} record(s) remaining` : ''}`
            : 'cleanup <strong class="hook-failed">did not run</strong>',
        ]
          .filter(Boolean)
          .join(' · ')}</small></p>`
      : '';
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
      return `<li><strong>${escapeHTML(entry.severity ?? 'unknown severity')}</strong>${entry.gating ? ' · fails quality' : ''} · <code>${escapeHTML(entry.ruleId)}</code> · ${escapeHTML(entry.reproduction.checkpoint)} step ${entry.reproduction.step}${entry.checkpoints.length > 1 ? ` (also seen unchanged at ${escapeHTML(entry.checkpoints.slice(1).join(', '))})` : ''}${entry.reproduction.url ? ` · ${escapeHTML(entry.reproduction.url)}` : ''}: ${escapeHTML(entry.description)}${entry.tags.length ? ` <small>${escapeHTML(entry.tags.join(', '))}</small>` : ''}${entry.helpUrl ? ` · <a href="${escapeHTML(entry.helpUrl)}">guidance</a>` : ''}${entry.evidence.screenshot ? ` · <a href="${link(entry.evidence.screenshot)}">screenshot</a>` : ''}${entry.nodeCount > entry.targets.length ? ` <small>(${entry.targets.length} of ${entry.nodeCount} elements shown)</small>` : ''}${targets ? `<ul>${targets}</ul>` : ''}</li>`;
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
    const auditMs = audits.runs.reduce(
      (total, run) => total + run.durationMs,
      0,
    );
    const budgetNote =
      outcome.category === 'budget_exhausted' && auditMs > 0
        ? `<p><small>Audits took ${(auditMs / 1000).toFixed(1)} s of this run's ${(durationMs / 1000).toFixed(1)} s (${Math.round((auditMs / Math.max(1, durationMs)) * 100)}%); audit time counts against the journey deadline.</small></p>`
        : '';
    // Opened when a visual comparison did not match, so it is not missed.
    const attention = audits.runs.some(
      (run) => run.visual && run.visual.status !== 'match',
    );
    return `${budgetNote}<details${attention ? ' open' : ''}><summary>Audits: ${audits.runs.length} run(s), ${violations.length} violation(s), ${review.length} needing manual review · ${(auditMs / 1000).toFixed(1)} s audit time · fail on ${escapeHTML(audits.failOn)}</summary><ul>${runs}${notReached}</ul>${visualHTML(audits.runs, link)}${violations.length ? `<h3>Audit violations</h3><ul>${violations.map(finding).join('')}</ul>` : ''}${review.length ? `<h3>Needs manual review</h3><p><small>Not counted in the quality verdict.</small></p><ul>${review.map(finding).join('')}</ul>` : ''}</details>`;
  };
  // What each evidence format captured or why it was disabled.
  const evidence = ({ evidence }: Result) => {
    const disabled = evidence.formats.filter((format) => !format.enabled);
    const items = evidence.formats
      .map(
        (format) =>
          `<li><code>${escapeHTML(format.format)}</code> ${format.enabled ? 'enabled' : '<strong>disabled</strong>'} · ${escapeHTML(format.destination === 'provider' ? 'sent to the model provider' : 'local only')} · ${escapeHTML(format.protection.replace('_', ' '))}: ${escapeHTML(format.reason)}</li>`,
      )
      .join('');
    const limitations = evidence.limitations
      .map(
        (limitation) =>
          `<li><strong>Limitation</strong>: ${escapeHTML(limitation)}</li>`,
      )
      .join('');
    return `<details${evidence.limitations.length ? ' open' : ''}><summary>Evidence: ${disabled.length ? `${disabled.length} format(s) disabled (${escapeHTML(disabled.map((format) => format.format).join(', '))})` : 'all formats enabled'} · ${evidence.declaredPatterns} suite pattern(s), ${evidence.redactedEnv.length} redacted environment value(s), ${evidence.redactedData.length} redacted setup value(s), ${evidence.masks} mask(s)${evidence.limitations.length ? ` · <strong>${evidence.limitations.length} protection limitation(s)</strong>` : ''}</summary><ul>${limitations}${items}</ul></details>`;
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(name)}</title>
<style>table{border-collapse:collapse;background:white;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}body{font:16px system-ui;margin:40px auto;max-width:1080px;padding:0 20px;color:#20252b;background:#f4f5f7}article{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}img{width:100%;border:1px solid #ddd}h1,h2{line-height:1.2}a{color:#2255ac}code{overflow-wrap:anywhere}small{color:#596574}.passed,.quality-pass{color:#176339}.failed,.error,.quality-fail{color:#a12727}.blocked{color:#895700}.quality-not_evaluated{color:#596574}.audit-findings,.audit-error{color:#a12727}.audit-incomplete,.audit-unsupported{color:#895700}.audit-clean{color:#176339}.visual-match{color:#176339}.visual-mismatch{color:#a12727}.visual-missing,.visual-incompatible,.visual-unstable{color:#895700}.cleanup-failed,.hook-failed{color:#a12727}.cleanup-failed[role=alert]{border:2px solid #a12727;border-radius:8px;padding:12px;background:#fff5f5}.hook-ok{color:#176339}</style>
<h1>${escapeHTML(name)}</h1>${cleanupBanner}<p>${results.filter((result) => result.status === 'passed').length}/${results.length} runs reached their asserted outcome. Quality verdicts, kept separate from that outcome: ${verdicts.pass} pass, ${verdicts.fail} fail, ${verdicts.not_evaluated} not evaluated (not evaluated is not a pass). Model concerns require human review. These runs are synthetic task probes, not measured human usability.${scanned.length ? ` Automated audits ran at configured checkpoints (${escapeHTML(scanned.join(', '))}); an automated scan does not establish accessibility or standards conformance.` : ' No automated audit ran; this is not an accessibility audit.'}</p>
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
    ) => `<article><h2>${escapeHTML(result.journey)} · ${escapeHTML(result.viewport)}${result.attempt > 1 || results.some((other) => other !== result && other.journey === result.journey && other.viewport === result.viewport) ? ` · run ${result.attempt}` : ''}</h2>${outcome(result)}${dataLifecycle(result)}${quality(result)}${audits(result)}<p>${result.steps} actions · ${(result.durationMs / 1000).toFixed(1)} seconds · ${result.usage.planner.calls + result.usage.selector.calls} model calls, ${result.usage.planner.inputTokens + result.usage.selector.inputTokens} input / ${result.usage.planner.outputTokens + result.usage.selector.outputTokens} output tokens · outcome checks: ${result.checks.map((ok) => (ok ? 'pass' : 'fail')).join(', ') || 'not evaluated'}</p><p>${result.trace ? `<a href="${link(result.trace)}">${result.trace.endsWith('.json') ? 'Final accessibility tree' : 'Local Playwright trace'}</a>` : 'No trace captured'}${result.video ? ` · <a href="${link(result.video)}">Video</a>` : ''}</p>${evidence(result)}
${result.findings.map((finding, index) => `<details><summary>${index + 1}. ${escapeHTML(finding.kind)} / ${escapeHTML(finding.category)} / step ${finding.step}</summary><p>${escapeHTML(finding.description)}</p><a href="${link(finding.screenshot)}"><img src="${link(finding.screenshot)}" alt="Evidence at step ${finding.step}" loading="lazy"></a></details>`).join('')}
</article>`,
  )
  .join(
    '',
  )}<p>Raw observations, decisions, and execution outcomes: <code>events.jsonl</code>. Screenshots, videos and traces may contain private organization data and session material; keep this run local. Redaction and masks remove the patterns, environment values and elements they are given plus well-known credential shapes; they are not a guarantee for arbitrary unknown sensitive content.</p></html>`;
}
