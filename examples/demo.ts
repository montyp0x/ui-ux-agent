import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { suiteSchema } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    `<!doctype html><html lang="en"><title>Demo documentation site</title><style>body{font:18px system-ui;max-width:800px;margin:60px auto;padding:24px;color:#18223a;background:#f3f5f8}main{padding:24px;border-radius:12px;background:white}a{display:block;margin:16px 0}</style><main>${request.url === '/docs/install' ? '<h1>Install the example product</h1><p>Download the package, choose a workspace, and start the application.</p>' : request.url === '/docs' ? '<h1>Documentation</h1><a href="/docs/install">Installation guide</a>' : '<h1>Example product</h1><a href="/docs">Documentation</a>'}</main></html>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string')
  throw new Error('Demo server failed to bind');
// `npm run demo -- --browser webkit` runs the same demo on another engine
// (validated by the suite schema; see README "Browser support").
const browserAt = process.argv.indexOf('--browser');
const browser = browserAt === -1 ? undefined : process.argv[browserAt + 1];
const suite = suiteSchema.parse({
  name: 'Offline documentation demo — deterministic decisions',
  baseURL: `http://127.0.0.1:${address.port}`,
  ...(browser === undefined ? {} : { browser }),
  requiresAuth: false,
  viewports: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'narrow', width: 390, height: 844 },
  ],
  journeys: [
    {
      id: 'find-installation',
      goal: 'Find the installation instructions',
      persona: 'A new product user',
      startPath: '/',
      allowedPaths: ['/', '/docs'],
      ready: {
        kind: 'visible',
        target: { by: 'role', role: 'heading', name: 'Example product' },
      },
      success: [
        { kind: 'path', pattern: '^/docs/install$' },
        {
          kind: 'visible',
          target: {
            by: 'role',
            role: 'heading',
            name: 'Install the example product',
          },
        },
      ],
      // A reviewed route, compared in each run's task-friction summary.
      referencePaths: [
        {
          name: 'via-documentation',
          waypoints: [
            { kind: 'page', pattern: '^/docs$' },
            { kind: 'action', action: 'link', to: '^/docs/install$' },
          ],
          expectedActions: 2,
        },
      ],
    },
  ],
});
const decisions: Models = {
  async plan() {
    return {
      objective: 'Follow the visible documentation links',
      concerns: [],
    };
  },
  async choose(_journey, _observation, _plan, actions) {
    const choice =
      actions.find((action) => action.kind === 'link')?.id ?? 'no_match';
    return {
      type: 'choice',
      choice,
      confidence: 1,
      probabilities: Object.fromEntries([
        ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
        ['no_match', choice === 'no_match' ? 1 : 0],
      ]),
    };
  },
};
try {
  const directory = resolve(
    `runs/demo-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  const results = await runSuite(suite, decisions, { directory, video: true });
  for (const result of results)
    console.log(
      `${result.status} [${result.outcome.code}]: ${result.journey}/${result.viewport} · ${suite.browser} · quality ${result.quality.verdict} · agent friction: ${result.friction?.actions.product ?? 0} product action(s), ${result.friction?.counts.backtracks ?? 0} backtrack(s), closest reference path ${result.friction?.reference?.closest ?? 'none'}`,
    );
  console.log(`Report: ${directory}/report.html`);
  process.exitCode = results.every((result) => result.status === 'passed')
    ? 0
    : 1;
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
