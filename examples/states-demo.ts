// Runs the state coverage and keyboard-only example suites against the local
// state fixture, and the write-flow suite with its data lifecycle against the
// notes fixture, with scripted, deterministic decisions (no model calls).
// `npm run demo:states`; add `--defects` to turn on each page's deliberate
// defect and see the declared state checks fail while journeys still pass.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { KEYBOARD_JOURNEY_UNSUPPORTED } from '../src/browser-support.js';
import { suiteSchema } from '../src/contracts.js';
import { runSuite } from '../src/runner.js';
import { notesFixture } from './notes-fixture.js';
import { STATE_SCRIPTS, scriptedDecisions, stateFixture } from './state-fixture.js';

const defects = process.argv.includes('--defects');
// `-- --browser webkit` runs the suites on another engine; a suite the engine
// refuses (keyboard-only journeys on WebKit) is reported and skipped.
const browserAt = process.argv.indexOf('--browser');
const browser = browserAt === -1 ? undefined : process.argv[browserAt + 1];
const fixture = await stateFixture();
const notes = await notesFixture();
try {
  let failed = false;
  for (const file of ['states.json', 'keyboard.json', 'notes.json']) {
    const raw = JSON.parse(
      await readFile(new URL(file, import.meta.url), 'utf8'),
    ) as { journeys: { startPath: string }[] };
    if (defects)
      for (const journey of raw.journeys)
        journey.startPath += journey.startPath.includes('?')
          ? '&defect=1'
          : '?defect=1';
    // The example files name placeholder ports; point them at the fixtures.
    const url = file === 'notes.json' ? notes.url : fixture.url;
    const parsed = suiteSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          ...raw,
          baseURL: url,
          ...(browser === undefined ? {} : { browser }),
        }).replace(/http:\/\/127\.0\.0\.1:417[34]/g, url),
      ),
    );
    if (!parsed.success) {
      const refused = parsed.error.issues.find((issue) =>
        Object.values(KEYBOARD_JOURNEY_UNSUPPORTED).includes(issue.message),
      );
      if (!refused) throw parsed.error;
      console.log(`refused: ${file} on ${browser}: ${refused.message}`);
      continue;
    }
    const suite = parsed.data;
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
      if (result.dataLifecycle)
        console.log(
          `  data: setup ${result.dataLifecycle.setup?.status ?? 'none'}, cleanup ${result.dataLifecycle.cleanup?.status ?? 'did not run'} after ${result.dataLifecycle.cleanup?.trigger ?? '-'}, ${result.dataLifecycle.cleanup?.remaining ?? '?'} record(s) remaining`,
        );
      if (result.status !== 'passed' || result.dataLifecycle?.clean === false)
        failed = true;
    }
    console.log(`Report: ${join(directory, 'report.html')}`);
  }
  const left = notes.stored();
  console.log(`Notes fixture after the runs: ${left.notes} note(s), ${left.owners.length} identities`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await fixture.close();
  await notes.close();
}
