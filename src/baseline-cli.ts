// npm run baseline -- approve|list ...: the only commands that write or show
// approved visual baselines. A run never approves its own captures.
import { parseArgs } from 'node:util';
import { approveBaselines, listBaselines, visualKeyText } from './baselines.js';

const USAGE =
  'npm run baseline -- approve --run RUN_DIRECTORY --baselines DIR (--journey ID | --viewport NAME | --checkpoint ID | --all) [--replace] [--allow-failed-runs]\n' +
  'npm run baseline -- list --baselines DIR\n' +
  '\n' +
  'approve copies reviewed captures (visual-*-current.png in the run directory, see report.html) into DIR as the baseline for the environment they were rendered in. ' +
  'A capture that differs from an existing baseline is approved only with --replace. DIR must be outside Git or ignored by it.';

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        run: { type: 'string' },
        baselines: { type: 'string' },
        journey: { type: 'string' },
        viewport: { type: 'string' },
        checkpoint: { type: 'string' },
        all: { type: 'boolean' },
        replace: { type: 'boolean' },
        'allow-failed-runs': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (caught) {
    console.error(
      `${caught instanceof Error ? caught.message : String(caught)}\n${USAGE}`,
    );
    process.exit(2);
  }
})();

try {
  const [command, ...rest] = positionals;
  if (values.help || !command) console.log(USAGE);
  else if (rest.length)
    throw new Error(`Unexpected arguments: ${rest.join(' ')}`);
  else if (command === 'approve') {
    if (!values.run || !values.baselines)
      throw new Error('approve requires --run and --baselines');
    const decisions = await approveBaselines({
      run: values.run,
      baselines: values.baselines,
      journey: values.journey,
      viewport: values.viewport,
      checkpoint: values.checkpoint,
      all: values.all,
      replace: values.replace,
      allowFailedRuns: values['allow-failed-runs'],
    });
    if (!decisions.length)
      console.log('No visual captures in the run matched the selection.');
    for (const decision of decisions)
      console.log(
        `${decision.action}: ${visualKeyText(decision.key)} (run ${decision.attempt}, ${decision.status}): ${decision.reason}${decision.file ? ` -> ${decision.file}` : ''}`,
      );
    process.exitCode = decisions.some(
      (decision) => decision.action !== 'skipped',
    )
      ? 0
      : 1;
  } else if (command === 'list') {
    if (!values.baselines) throw new Error('list requires --baselines');
    const entries = await listBaselines(values.baselines);
    if (!entries.length) console.log('No approved baselines.');
    for (const entry of entries)
      console.log(
        `${entry.key.suite} ${visualKeyText(entry.key)} · ${entry.environment.browser.name} ${entry.environment.browser.version}${entry.environment.browser.headless ? ' headless' : ''} · ${entry.environment.os.platform}-${entry.environment.os.arch} ${entry.environment.os.release} · ${entry.environment.viewport.width}x${entry.environment.viewport.height}@${entry.environment.deviceScaleFactor} · ${entry.environment.locale} ${entry.environment.colorScheme} · approved ${entry.approvedAt} · ${entry.file}`,
      );
  } else throw new Error(`Unknown command ${command}\n${USAGE}`);
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 2;
}
