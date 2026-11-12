// Runs the state coverage and keyboard-only example suites against the local
// state fixture with scripted, deterministic decisions (no model calls).
// `npm run demo:states`; add `--defects` to turn on each page's deliberate
// defect and see the declared state checks fail while journeys still pass.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { suiteSchema } from '../src/contracts.js';
import { runSuite } from '../src/runner.js';
import { STATE_SCRIPTS, scriptedDecisions, stateFixture } from './state-fixture.js';

const defects = process.argv.includes('--defects');
const fixture = await stateFixture();
try {
  let failed = false;
  for (const file of ['states.json', 'keyboard.json']) {
    const raw = JSON.parse(
      await readFile(new URL(file, import.meta.url), 'utf8'),
    ) as { journeys: { startPath: string }[] };
    if (defects)
      for (const journey of raw.journeys)
        journey.startPath += journey.startPath.includes('?')
          ? '&defect=1'
          : '?defect=1';
    const suite = suiteSchema.parse({ ...raw, baseURL: fixture.url });
    const directory = resolve(
      `runs/demo-states-${file.replace('.json', '')}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    const results = await runSuite(suite, scriptedDecisions(STATE_SCRIPTS), {
      directory,
    });
    for (const result of results) {
      const findings = result.audits.findings.filter(
        (finding) => finding.certainty === 'violation',
      );
      console.log(
        `${result.status} [${result.outcome.code}]: ${result.journey} · quality ${result.quality.verdict}${findings.length ? ` · ${findings.map((finding) => `${finding.ruleId} at ${finding.reproduction.checkpoint}`).join(', ')}` : ''}`,
      );
      if (result.status !== 'passed') failed = true;
    }
    console.log(`Report: ${directory}/report.html`);
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  await fixture.close();
}
