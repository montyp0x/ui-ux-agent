// npm run compare -- BASE_RUN CANDIDATE_RUN [--gate FILE] [--out NEW_DIRECTORY]
//
// Exit codes: 0 compatible runs and the gate passed; 1 compatible runs and
// the gate failed; 2 usage or input error (missing or corrupt results, an
// invalid gate file, the same run twice, an existing --out directory);
// 3 the runs are incompatible, so the comparison is invalid.
import { parseArgs } from 'node:util';
import {
  COMPARE_EXIT,
  ComparisonInputError,
  comparisonExitCode,
} from './compare.js';
import {
  comparisonSummary,
  loadGate,
  writeComparison,
} from './compare-files.js';
import { Redactor } from './evidence/redact.js';

const USAGE =
  'npm run compare -- BASE_RUN CANDIDATE_RUN [--gate GATE.json] [--out NEW_DIRECTORY]\n' +
  '\n' +
  'Compares two runs of the same suite (directories holding results.json): new, persisting, resolved and unassessed findings, and the gate.\n' +
  'Writes comparison.json and comparison.html into --out (default: comparison-<time> inside the candidate run). Nothing is uploaded.\n' +
  'Exit codes: 0 gate passed, 1 gate failed, 2 usage or input error, 3 runs incompatible (comparison invalid).';

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        gate: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (caught) {
    console.error(
      `${caught instanceof Error ? caught.message : String(caught)}\n${USAGE}`,
    );
    process.exit(COMPARE_EXIT.inputError);
  }
})();

let redactor = new Redactor({ env: process.env });
try {
  if (values.help) console.log(USAGE);
  else {
    if (positionals.length !== 2)
      throw new ComparisonInputError(
        `Expected BASE_RUN and CANDIDATE_RUN, got ${positionals.length} argument(s)\n${USAGE}`,
      );
    const gate = await loadGate(values.gate);
    const files = await writeComparison({
      base: positionals[0]!,
      candidate: positionals[1]!,
      gate,
      out: values.out,
    });
    redactor = files.redactor;
    for (const line of comparisonSummary(files.comparison))
      console.log(redactor.text(line));
    console.log(`Comparison: ${files.json}`);
    console.log(`Report: ${files.html}`);
    process.exitCode = comparisonExitCode(files.comparison);
  }
} catch (caught) {
  console.error(
    redactor.text(caught instanceof Error ? caught.message : String(caught)),
  );
  process.exitCode = COMPARE_EXIT.inputError;
}
