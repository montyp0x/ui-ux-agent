import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium, firefox, webkit } from 'playwright';
import {
  dedicatedProfile,
  scopeStorageState,
  storageStateSchema,
  suiteOrigins,
} from './auth.js';
import { parseArgs } from 'node:util';
import { modelOptionsFromEnv } from './config.js';
import { browserLaunchOptions } from './drivers/playwright.js';
import { suiteEvidencePolicy, suiteSchema } from './contracts.js';
import { models } from './models.js';
import { runSuite } from './runner.js';
import { starterSuite } from './scaffold.js';
import { exitCode, summarize } from './summary.js';
import { pruneRuns } from './evidence/retention.js';
import { Redactor } from './evidence/redact.js';

const options = {
  suite: { type: 'string' },
  url: { type: 'string' },
  'storage-state': { type: 'string' },
  out: { type: 'string' },
  journey: { type: 'string' },
  viewport: { type: 'string' },
  headed: { type: 'boolean' },
  video: { type: 'boolean' },
  validate: { type: 'boolean' },
  help: { type: 'boolean' },
  init: { type: 'string' },
  'success-path': { type: 'string' },
  goal: { type: 'string' },
  browser: { type: 'string' },
  'env-file': { type: 'string' },
  login: { type: 'string' },
  repeat: { type: 'string' },
  from: { type: 'string' },
  profile: { type: 'string' },
  'sign-in': { type: 'boolean' },
  'prune-runs': { type: 'string' },
  'dry-run': { type: 'boolean' },
  baselines: { type: 'string' },
} as const;
// Unknown flags (including the removed --from-browser, which read sessions out
// of an installed browser's personal profile) are rejected with exit code 2.
const { values } = (() => {
  try {
    return parseArgs({ options });
  } catch (caught) {
    console.error(
      `${caught instanceof Error ? caught.message : String(caught)}. Run with --help for the supported options.`,
    );
    process.exit(2);
  }
})();

// Credentials come from the environment. An explicit --env-file, or ./.env when
// present, is loaded first; variables already set in the shell take precedence.
function loadCredentials(): void {
  const path = values['env-file']
    ? resolve(values['env-file'])
    : existsSync('.env')
      ? resolve('.env')
      : null;
  if (!path) return;
  process.loadEnvFile(path);
  console.log(`Loaded environment from ${path}`);
}
if (values.help) {
  console.log(
    'npm run run -- --init suite.json --url URL --success-path /destination [--goal GOAL]\n' +
      'npm run run -- --suite suite.json --profile .auth/profiles/NAME --sign-in   (once; later runs pass the same --profile)\n' +
      'npm run run -- --suite suite.json --login .auth/app.json [--from EXISTING_STATE.json] [--url URL]\n' +
      'npm run run -- --suite suite.json [--url URL] [--browser chromium|firefox|webkit] [--profile DIR | --storage-state PATH] [--journey ID] [--viewport NAME] [--out NEW_DIRECTORY] [--repeat N] [--baselines DIR] [--env-file PATH] [--headed] [--video] [--validate]\n' +
      'npm run baseline -- approve --run RUN_DIRECTORY --baselines DIR (--journey ID | --viewport NAME | --checkpoint ID | --all) [--replace]\n' +
      '\n' +
      'npm run run -- --prune-runs runs [--dry-run]   (deletes run directories whose evidence.retentionDays have passed)\n' +
      '\n' +
      '--profile DIR is a dedicated test profile the runner creates; a personal browser profile is refused, and no session is read from an installed browser.\n' +
      '--baselines DIR is your local directory of approved visual baselines, outside Git; runs only read it, and --prune-runs never touches it.\n' +
      'Runs are never overwritten, uploaded or deleted automatically.',
  );
} else if (values['prune-runs']) {
  // Explicit retention: only directories with this tool's run manifest whose
  // retention has passed; anything else under the root is left alone.
  try {
    for (const entry of await pruneRuns(resolve(values['prune-runs']), {
      dryRun: values['dry-run'],
    }))
      console.log(`${entry.action}: ${entry.directory} (${entry.reason})`);
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 2;
  }
} else {
  // Error messages can quote page text; redact them like other evidence once
  // the suite's patterns are known.
  let redactor = new Redactor({ env: process.env });
  try {
    if (values.profile && (values['storage-state'] || values.login))
      throw new Error('Use --profile or --storage-state/--login, not both');
    if (values.init) {
      if (!values.url || !values['success-path'])
        throw new Error('--init requires --url and --success-path');
      const starter = starterSuite(
        values.url,
        values['success-path'],
        values.goal,
      );
      await writeFile(
        resolve(values.init),
        JSON.stringify(starter, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      console.log(
        `Created ${resolve(values.init)}. Review the goal, allowed paths, and content assertions before running.`,
      );
    } else {
      if (!values.suite) throw new Error('--suite is required');
      const raw: unknown = JSON.parse(
        await readFile(resolve(values.suite), 'utf8'),
      );
      const suite = suiteSchema.parse(raw);
      redactor = new Redactor({
        patterns: suite.evidence.redact,
        envNames: suiteEvidencePolicy(suite).redactEnv,
        env: process.env,
      });
      if (values.url)
        suite.baseURL = suiteSchema.parse({
          ...suite,
          baseURL: values.url,
        }).baseURL;
      if (values.browser)
        suite.browser = suiteSchema.parse({
          ...suite,
          browser: values.browser,
        }).browser;
      if (values['sign-in']) {
        // One-time sign-in into a persistent profile; runs with the same
        // --profile reuse it, with no further login or Keychain access.
        if (!values.profile)
          throw new Error('--sign-in requires --profile DIR');
        const profile = await dedicatedProfile(values.profile);
        const context = await { chromium, firefox, webkit }[
          suite.browser
        ].launchPersistentContext(profile, {
          headless: false,
          ...browserLaunchOptions(suite),
        });
        try {
          const page = context.pages()[0] ?? (await context.newPage());
          await page.goto(suite.baseURL);
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          await prompt.question(
            `Sign in to ${suite.baseURL} in the opened browser, then press Enter here to keep the profile. `,
          );
          prompt.close();
        } finally {
          await context.close();
        }
        await chmod(profile, 0o700);
        console.log(
          `Saved profile ${profile}. Run with --profile ${values.profile} to reuse this sign-in.`,
        );
      } else if (values.login) {
        // Capture (or import with --from) a session, scoped to the suite's origins.
        let raw: unknown;
        if (values.from)
          raw = JSON.parse(await readFile(resolve(values.from), 'utf8'));
        else {
          const browser = await { chromium, firefox, webkit }[
            suite.browser
          ].launch({
            headless: false,
            // Sign in with the same browser build the runs use.
            ...browserLaunchOptions(suite),
          });
          try {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(suite.baseURL);
            const prompt = createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            await prompt.question(
              `Sign in to ${suite.baseURL} in the opened browser, then press Enter here to save the session. `,
            );
            prompt.close();
            raw = await context.storageState();
          } finally {
            await browser.close();
          }
        }
        const { state, report } = scopeStorageState(
          storageStateSchema.parse(raw),
          suiteOrigins(suite),
        );
        const out = resolve(values.login);
        await mkdir(dirname(out), { recursive: true, mode: 0o700 });
        await writeFile(out, JSON.stringify(state, null, 2), { mode: 0o600 });
        await chmod(out, 0o600);
        console.log(
          `Saved ${out}: ${report.keptCookies} cookies and ${report.keptOrigins.length} origins for ${suiteOrigins(suite).join(', ')}; dropped ${Object.values(report.droppedCookies).reduce((sum, count) => sum + count, 0)} cookies (${Object.keys(report.droppedCookies).join(', ') || 'none'}) and ${report.droppedOrigins.length} origins.`,
        );
      } else if (values.validate) {
        console.log(
          `Valid suite: ${suite.name} (${suite.journeys.length} journeys, ${suite.viewports.length} viewports)`,
        );
      } else {
        loadCredentials();
        // Credentials loaded from .env are redacted too.
        redactor = new Redactor({
          patterns: suite.evidence.redact,
          envNames: suiteEvidencePolicy(suite).redactEnv,
          env: process.env,
        });
        const options = modelOptionsFromEnv(process.env);
        const directory = resolve(
          values.out ??
            `runs/${new Date().toISOString().replace(/[:.]/g, '-')}`,
        );
        console.log(`Live action log: ${directory}/events.jsonl`);
        // Ctrl-C cancels: the current run stops, its data cleanup still
        // runs and no further run starts. A second Ctrl-C exits at once.
        const cancel = new AbortController();
        process.once('SIGINT', () => {
          console.error(
            'Cancelling: finishing data cleanup for the current run (Ctrl-C again to exit now)',
          );
          cancel.abort();
          process.once('SIGINT', () => process.exit(130));
        });
        const results = await runSuite(
          suite,
          (log) =>
            models({
              ...options,
              onCall: (data) => log('model_call', data),
              onWait: (data) => log('model_wait', data),
            }),
          {
            directory,
            storageState: values['storage-state']
              ? resolve(values['storage-state'])
              : undefined,
            profile: values.profile
              ? await dedicatedProfile(values.profile)
              : undefined,
            headless: !values.headed,
            video: values.video,
            journey: values.journey,
            viewport: values.viewport,
            repeat: values.repeat ? Number(values.repeat) : 1,
            baselines: values.baselines,
            signal: cancel.signal,
          },
        );
        // The exit code follows the functional outcome only; the quality
        // verdict is reported beside it and does not gate yet.
        for (const result of results)
          console.log(
            `${result.status} [${result.outcome.code}]: ${result.journey}/${result.viewport}: ${result.reason} · quality ${result.quality.verdict}`,
          );
        for (const row of summarize(results))
          if (row.runs > 1)
            console.log(
              `${row.journey}/${row.viewport}: ${row.passed}/${row.runs} passed, median ${row.medianSteps} actions, ${(row.medianDurationMs / 1000).toFixed(1)}s`,
            );
        const unclean = results.filter(
          (result) => result.dataLifecycle && !result.dataLifecycle.clean,
        );
        for (const result of unclean)
          console.error(
            `CLEANUP FAILED: ${result.journey}/${result.viewport} run ${result.dataLifecycle!.run} on ${result.dataLifecycle!.service}: ${result.dataLifecycle!.cleanup?.detail ?? 'cleanup did not run'}`,
          );
        console.log(`Report: ${directory}/report.html`);
        // A failed data cleanup fails the command even when every run passed.
        process.exitCode = exitCode(results);
      }
    }
  } catch (caught) {
    console.error(
      redactor.text(caught instanceof Error ? caught.message : String(caught)),
    );
    process.exitCode = 2;
  }
}
