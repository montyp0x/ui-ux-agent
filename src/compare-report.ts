// comparison.html: the human-readable view of a comparison (comparison.json
// holds the same data). Local evidence links are relative to the output
// directory; nothing is uploaded.
import { relative, sep } from 'node:path';
import type { Comparison, FindingInstance } from './compare.js';
import { escapeHTML } from './report.js';

export function comparisonHTML(
  comparison: Comparison,
  outDirectory: string,
): string {
  const link = (file: string) =>
    encodeURI(relative(outDirectory, file).split(sep).join('/'));
  const identity = (side: 'base' | 'candidate') => {
    const run = comparison[side];
    const id = run.identity;
    if (!id)
      return `<td><code>${escapeHTML(run.run)}</code><br>no run identity</td>`;
    const browser = id.environment.browser;
    return `<td><code>${escapeHTML(run.run)}</code><br>build <strong>${escapeHTML(id.build ? `${id.build.id} (${id.build.source})` : 'unknown')}</strong><br>suite ${escapeHTML(id.suite.name)} <code>${id.suite.hash.slice(0, 12)}</code> · ${escapeHTML(id.suite.target ?? 'no target')}<br>engine ${escapeHTML(id.engine.version)} · result v${id.engine.resultVersion} · audits v${id.engine.auditContractVersion}<br>${escapeHTML(`${id.environment.platform} · ${id.environment.driver}${browser ? ` · ${browser.name} ${browser.version ?? 'unknown version'} (${browser.build}${browser.headless ? ', headless' : ''})` : ''} · ${id.environment.os.platform}-${id.environment.os.arch} ${id.environment.os.release} · node ${id.environment.node}`)}<br>models: ${escapeHTML(id.models ? `planner ${id.models.planner.model} @ ${id.models.planner.endpoint}; selector ${id.models.selector.model} @ ${id.models.selector.endpoint} (${id.models.selector.protocol})` : 'custom (not recorded)')}</td>`;
  };
  const fields = (title: string, list: Comparison['warnings']) =>
    list.length
      ? `<h2>${title}</h2><table><thead><tr><th>Field</th><th>Base</th><th>Candidate</th><th>Why it matters</th></tr></thead><tbody>${list.map((field) => `<tr><td><code>${escapeHTML(field.field)}</code></td><td>${escapeHTML(field.base)}</td><td>${escapeHTML(field.candidate)}</td><td>${escapeHTML(field.message)}</td></tr>`).join('')}</tbody></table>`
      : '';
  const evidence = (instance: FindingInstance) =>
    [instance.evidence.screenshot, ...instance.evidence.files]
      .flatMap((file) =>
        file
          ? [
              `<a href="${link(file)}">${escapeHTML(file.split(/[\\/]/).at(-1) ?? file)}</a>`,
            ]
          : [],
      )
      .join(' ');
  const row = (instance: FindingInstance, extra: string, gating: boolean) =>
    `<tr${gating ? ' class="gating"' : ''}><td>${gating ? '<strong>GATES</strong>' : ''}</td><td><code>${escapeHTML(instance.gateKey)}</code><br><small>${escapeHTML(instance.kind === 'audit' ? `${instance.certainty ?? ''} · ${instance.severity ?? 'no severity'}` : instance.kind)}</small></td><td>${escapeHTML(`${instance.journey}/${instance.viewport}`)}${instance.checkpoint ? `<br><small>${escapeHTML(instance.checkpoint)} ${escapeHTML(instance.path ?? '')}</small>` : ''}</td><td>${escapeHTML(instance.target ? (instance.target.selector ?? instance.target.description) : '—')}</td><td>${escapeHTML(instance.description)}${extra}</td><td>${evidence(instance)}</td><td><code>${instance.id}</code></td></tr>`;
  const table = (title: string, note: string, rows: string[]) =>
    `<h2>${title} (${rows.length})</h2><p><small>${note}</small></p>${rows.length ? `<table><thead><tr><th></th><th>Rule</th><th>Where</th><th>Target</th><th>Finding</th><th>Evidence</th><th>Id</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : ''}`;
  const { findings, gate } = comparison;
  const verdict = !comparison.compatible
    ? '<p class="invalid" role="alert"><strong>COMPARISON INVALID</strong>: the runs did not measure the same thing, so no finding is called new, persisting or resolved. Fix the fields below and compare compatible runs.</p>'
    : gate?.passed
      ? `<p class="pass"><strong>GATE PASSED</strong> (fail on ${escapeHTML(gate.config.failOn)})</p>`
      : `<p class="fail" role="alert"><strong>GATE FAILED</strong> (fail on ${escapeHTML(gate!.config.failOn)}): ${gate!.failures.length} failure(s)</p><ul>${gate!.failures.map((failure) => `<li><code>${failure.code}</code> ${escapeHTML(failure.message)}</li>`).join('')}</ul>`;
  const lost = comparison.checks.filter(
    (check) => check.candidate !== 'assessed',
  );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Run comparison</title>
<style>table{border-collapse:collapse;background:white;width:100%;margin:8px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}body{font:16px system-ui;margin:40px auto;max-width:1180px;padding:0 20px;color:#20252b;background:#f4f5f7}code{overflow-wrap:anywhere}small{color:#596574}.pass{color:#176339}.fail,.invalid{color:#a12727;border:2px solid #a12727;border-radius:8px;padding:12px;background:#fff5f5}tr.gating{background:#fff5f5}</style>
<h1>Run comparison</h1>${verdict}
<table><thead><tr><th>Base</th><th>Candidate</th></tr></thead><tbody><tr>${identity('base')}${identity('candidate')}</tr></tbody></table>
${fields('Why the comparison is invalid', comparison.incompatibilities)}${fields('Warnings', comparison.warnings)}
${
  comparison.compatible
    ? `<h2>Functional outcomes</h2><table><thead><tr><th>Journey/viewport</th><th>Base passed</th><th>Candidate passed</th><th></th></tr></thead><tbody>${comparison.outcomes.map((outcome) => `<tr><td>${escapeHTML(`${outcome.journey}/${outcome.viewport}`)}</td><td>${outcome.base ? `${outcome.base.passed}/${outcome.base.runs}` : 'not run'}</td><td>${outcome.candidate ? `${outcome.candidate.passed}/${outcome.candidate.runs}` : 'not run'}</td><td>${outcome.regression ? '<strong>REGRESSION</strong>' : ''}</td></tr>`).join('')}</tbody></table>
${table(
  'New',
  'Reported by the candidate, not by the base.',
  findings.new.map((entry) => row(entry.candidate, '', entry.gating)),
)}
${table(
  'Unassessed',
  'Reported by the base; the candidate did not assess where it was measured, so its absence is not a fix.',
  findings.unassessed.map((entry) =>
    row(
      entry.base,
      `<br><small><code>${entry.reason}</code> ${escapeHTML(entry.detail)}</small>`,
      entry.gating,
    ),
  ),
)}
${table(
  'Persisting',
  'Reported by both runs.',
  findings.persisting.map((entry) =>
    row(
      entry.candidate,
      entry.escalated
        ? `<br><small><strong>escalated</strong> from ${escapeHTML(`${entry.base.certainty ?? entry.base.kind} · ${entry.base.severity ?? 'no severity'}`)}</small>`
        : '',
      entry.gating,
    ),
  ),
)}
${table(
  'Resolved',
  'Reported by the base; the candidate assessed the same check, page and elements and did not report it.',
  findings.resolved.map((entry) => row(entry.base, '', false)),
)}
<h2>Checks not assessed by the candidate (${lost.length})</h2>${lost.length ? `<table><thead><tr><th>Journey/viewport</th><th>Audit</th><th>Checkpoint</th><th>Base</th><th>Candidate</th></tr></thead><tbody>${lost.map((check) => `<tr${check.coverageLost ? ' class="gating"' : ''}><td>${escapeHTML(`${check.journey}/${check.viewport}`)}</td><td><code>${escapeHTML(check.auditId)}</code></td><td>${escapeHTML(check.checkpoint)}</td><td>${check.base}</td><td>${check.candidate}${check.coverageLost ? ' · <strong>coverage lost</strong>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p>None.</p>'}`
    : ''
}
<p><small>Model hypotheses and needs-review items are listed but do not gate unless the gate turns them on. Finding ids exclude steps, timestamps, run markers, evidence paths, URL origins and queries, and digits in descriptions. Evidence links point into the local run directories; keep them local.</small></p></html>`;
}
