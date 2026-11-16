// Runs examples/performance.json against the local performance fixture with
// scripted, deterministic decisions (no model calls): first the slow page,
// then its fast twin, and compares the two runs. `npm run demo:performance`.
// The numbers are this machine's, from one run each; they show the evidence
// the audit produces, not a benchmark.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { suiteSchema, type Action, type Choice } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import { writeComparison } from '../src/compare-files.js';
import { gateSchema } from '../src/gate.js';
import { performanceSite } from './performance-fixture.js';

const choice = (actions: Action[], id: string): Choice => ({
  type: 'choice',
  choice: id,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === id ? 1 : 0]),
    ['no_match', id === 'no_match' ? 1 : 0],
  ]),
});
const scripted: Models = {
  async plan() {
    return { objective: 'Apply the changes', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return choice(
      actions,
      actions.find((action) => action.kind === 'click')?.id ?? 'no_match',
    );
  },
};

const site = await performanceSite();
try {
  const raw = JSON.parse(
    await readFile(new URL('performance.json', import.meta.url), 'utf8'),
  );
  // The example names a placeholder port; point it at the fixture.
  const suite = () => suiteSchema.parse({ ...raw, baseURL: site.url });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runs: string[] = [];
  for (const mode of ['slow', 'fast'] as const) {
    site.state.mode = mode;
    const directory = resolve(`runs/performance-demo-${stamp}-${mode}`);
    const [result] = await runSuite(suite(), scripted, { directory, env: {} });
    runs.push(directory);
    for (const run of result!.audits.runs) {
      const metrics = run.performance?.metrics;
      console.log(
        `${mode} ${run.checkpoint.id}: ${run.status}${metrics ? ` · lcp ${metrics.lcpMs} ms · cls ${metrics.cls} · inp ${metrics.inpMs ?? 'n/a'} ms · blocking ${metrics.blockingTimeMs} ms` : ` ${run.detail ?? ''}`}`,
      );
    }
    console.log(
      `${mode}: outcome ${result!.status}, quality ${result!.quality.verdict}, ${result!.audits.findings.length} budget finding(s) · report ${directory}/report.html`,
    );
  }
  const { comparison, html } = await writeComparison({
    base: runs[0]!,
    candidate: runs[1]!,
    gate: gateSchema.parse({}),
  });
  console.log(
    `compare slow → fast: ${comparison.counts.resolved} resolved, ${comparison.counts.new} new; ${comparison.performance.filter((entry) => entry.status === 'compared').length} metrics compared · ${html}`,
  );
} finally {
  await site.close();
}
