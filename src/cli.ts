import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium, firefox, webkit } from 'playwright';
import { scopeStorageState, storageStateSchema, suiteOrigins } from './auth.js';
import { parseArgs } from 'node:util';
import { modelOptionsFromEnv } from './config.js';
import { suiteSchema } from './contracts.js';
import { models } from './models.js';
import { runSuite } from './runner.js';
import { starterSuite } from './scaffold.js';

const { values } = parseArgs({
  options: {
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
    from: { type: 'string' },
  },
});

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
      'npm run run -- --suite suite.json --login .auth/app.json [--from EXISTING_STATE.json] [--url URL]\n' +
      'npm run run -- --suite suite.json [--url URL] [--browser chromium|firefox|webkit] [--storage-state PATH] [--journey ID] [--viewport NAME] [--out NEW_DIRECTORY] [--env-file PATH] [--headed] [--video] [--validate]',
  );
} else {
  try {
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
      if (values.login) {
        // Capture (or import with --from) a session, scoped to the suite's origins.
        let raw: unknown;
        if (values.from)
          raw = JSON.parse(await readFile(resolve(values.from), 'utf8'));
        else {
          const browser = await { chromium, firefox, webkit }[
            suite.browser
          ].launch({
            headless: false,
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
        const options = modelOptionsFromEnv(process.env);
        const directory = resolve(
          values.out ??
            `runs/${new Date().toISOString().replace(/[:.]/g, '-')}`,
        );
        console.log(`Live action log: ${directory}/events.jsonl`);
        const results = await runSuite(
          suite,
          (log) =>
            models({ ...options, onCall: (data) => log('model_call', data) }),
          {
            directory,
            storageState: values['storage-state']
              ? resolve(values['storage-state'])
              : undefined,
            headless: !values.headed,
            video: values.video,
            journey: values.journey,
            viewport: values.viewport,
          },
        );
        for (const result of results)
          console.log(
            `${result.status}: ${result.journey}/${result.viewport}: ${result.reason}`,
          );
        console.log(`Report: ${directory}/report.html`);
        process.exitCode = results.some((result) => result.status !== 'passed')
          ? 1
          : 0;
      }
    }
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 2;
  }
}
