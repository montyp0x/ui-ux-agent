import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
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
  },
});
if (values.help) {
  console.log(
    'npm run run -- --init suite.json --url URL --success-path /destination [--goal GOAL]\n' +
      'npm run run -- --suite suite.json [--url URL] [--browser chromium|firefox|webkit] [--storage-state PATH] [--journey ID] [--viewport NAME] [--out NEW_DIRECTORY] [--headed] [--video] [--validate]',
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
      if (values.validate) {
        console.log(
          `Valid suite: ${suite.name} (${suite.journeys.length} journeys, ${suite.viewports.length} viewports)`,
        );
      } else {
        const required = (key: string) => {
          const value = process.env[key];
          if (!value)
            throw new Error(
              `Missing ${key}; do not put credentials in the suite file`,
            );
          return value;
        };
        const options = {
          plannerURL:
            process.env.PLANNER_API_URL ??
            'https://openrouter.ai/api/v1/chat/completions',
          plannerKey:
            process.env.PLANNER_API_KEY ?? required('OPENROUTER_API_KEY'),
          plannerModel: process.env.PLANNER_MODEL ?? 'openai/gpt-6-astra',
          selectorURL:
            process.env.SELECTOR_API_URL ??
            'https://api.typesafe.ai/v1/systemone',
          selectorKey: required('TYPESAFE_API_KEY'),
          selectorModel: process.env.SELECTOR_MODEL ?? 'jev-latest',
        };
        const directory = resolve(
          values.out ??
            `runs/${new Date().toISOString().replace(/[:.]/g, '-')}`,
        );
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
