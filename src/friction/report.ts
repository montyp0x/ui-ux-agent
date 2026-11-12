// The report.html section for a run's task-friction summary.
import type { Friction } from './contract.js';

const KIND_LABEL: Record<Friction['items'][number]['kind'], string> = {
  backtrack: 'Backtrack',
  repeat: 'Repeat',
  recovery: 'Runner recovery',
  detour: 'Detour',
  failed_attempt: 'Failed attempt',
  no_effect: 'No visible effect',
};

export function frictionHTML(
  friction: Friction | undefined,
  { escape, link }: { escape: (text: string) => string; link: (file: string) => string },
): string {
  if (!friction) return '';
  const { actions, counts, overhead } = friction;
  const shot = (label: string, file: string | null) =>
    file ? `<a href="${link(file)}">${label}</a>` : '';
  const items = friction.items.length
    ? `<table><thead><tr><th>Kind</th><th>By</th><th>Step</th><th>What</th><th>Evidence</th></tr></thead><tbody>${friction.items
        .map(
          (item) =>
            `<tr><td>${KIND_LABEL[item.kind]}</td><td>${item.actor === 'product' ? 'agent on the product' : 'runner overhead'}</td><td>${item.step}</td><td>${escape(item.description)}${item.detail ? `<br><small>${escape(item.detail)}</small>` : ''}${item.url ? `<br><small><code>${escape(item.url)}</code></small>` : ''}</td><td>${[shot('state', item.before), shot('next state', item.after), `<a href="events.jsonl">events.jsonl line ${item.line}</a>`].filter(Boolean).join(' · ')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p><small>No backtracks, repeats, recoveries, detours, failed attempts or actions without visible effect were recorded.</small></p>';
  const reasons = Object.entries(overhead.refreshReasons)
    .map(([reason, total]) => `${total}× ${reason}`)
    .join(', ');
  const reference = friction.reference
    ? `<h3>Reference paths</h3><p><small>${escape(friction.reference.note)}</small></p><table><thead><tr><th>Path</th><th>Waypoints matched</th><th>Agent actions (expected / compared / allowed / extra)</th></tr></thead><tbody>${friction.reference.paths
        .map(
          (path) =>
            `<tr><td>${escape(path.name)}${path.name === friction.reference!.closest ? ' <small>(closest)</small>' : ''}${path.ordered ? '' : ' <small>(any order)</small>'}</td><td>${path.followed ? 'all' : `${path.matched} of ${path.total}`}<ul>${path.waypoints
              .map(
                (waypoint) =>
                  `<li>${waypoint.matched ? 'matched' : '<strong>not matched</strong>'} <code>${escape(waypoint.label)}</code>${waypoint.line ? ` · step ${waypoint.step} · events.jsonl line ${waypoint.line}` : ''}</li>`,
              )
              .join('')}</ul></td><td>${path.expectedActions} / ${path.comparedActions} / ${path.allowedActions} / ${path.extraActions}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';
  const rubric = `<h3>Review rubric</h3><p><small>Questions for a human reviewer, with the counts of this run that bear on each. No dimension is scored; every one is pending human review, and no signals counted does not mean the dimension is good.</small></p><table><thead><tr><th>Dimension</th><th>Question</th><th>Signals in this run</th><th>Status</th></tr></thead><tbody>${friction.rubric
    .map(
      (entry) =>
        `<tr><td>${escape(entry.dimension)}</td><td>${escape(entry.question)}</td><td>${entry.signals.map((item) => `${escape(item.signal)} ${item.count}`).join(', ')}</td><td>${entry.status === 'signals_observed' ? 'signals observed' : 'no signals counted'} · pending human review</td></tr>`,
    )
    .join('')}</tbody></table>`;
  const concerns = friction.hypotheses.reduce(
    (total, entry) => total + entry.concerns,
    0,
  );
  const hypotheses = concerns
    ? `<p><small>${concerns} model concern(s) raised at step(s) ${friction.hypotheses.map((entry) => entry.step).join(', ')} are hypotheses pending human review (listed with the findings below), never part of an outcome or verdict.</small></p>`
    : '';
  const flagged =
    counts.backtracks +
    counts.repeats +
    counts.recoveries +
    counts.detours +
    counts.failedAttempts +
    counts.noEffect;
  return `<details><summary>Task friction (agent run): ${actions.product} agent action(s) on the product, ${actions.waits} wait(s), ${actions.recovery} runner recovery action(s) · ${flagged ? `${counts.backtracks} backtrack(s), ${counts.repeats} repeat(s), ${counts.recoveries} recovery(ies), ${counts.detours} detour step(s), ${counts.failedAttempts} failed attempt(s), ${counts.noEffect} without visible effect` : 'nothing flagged'}${friction.reference?.closest ? ` · closest reference path ${escape(friction.reference.closest)}` : ''}</summary><p><small>${escape(friction.note)}</small></p>${items}<p><small>Planner and runner overhead (not product actions): ${overhead.plannerRefreshes} planner refresh(es)${reasons ? ` (${escape(reasons)})` : ''}, ${overhead.noMatchDecisions} no-match decision(s), ${overhead.revisitReplans} replan(s) before revisiting a tried state, ${overhead.recoveryActions} recovery action(s). From events.jsonl lines ${friction.events.first ?? '—'}–${friction.events.last ?? '—'} (${friction.events.considered} event(s)${friction.events.unparsed ? `, <strong>${friction.events.unparsed} unreadable</strong>` : ''}).</small></p>${hypotheses}${reference}${rubric}</details>`;
}
