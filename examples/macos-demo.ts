// Offline macOS demo: builds the SwiftUI fixture app and runs a journey with
// deterministic decisions. Needs macOS plus Accessibility and Screen Recording
// permission for the app running it (e.g. Terminal).
import { resolve } from 'node:path';
import { suiteSchema, type Action } from '../src/contracts.js';
import {
  buildFixtureApp,
  FIXTURE_BUNDLE_ID,
} from '../src/drivers/macos-fixture.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';

const app = await buildFixtureApp();
const suite = suiteSchema.parse({
  name: 'Offline macOS fixture demo — deterministic decisions',
  platform: 'macos',
  app: { bundleId: FIXTURE_BUNDLE_ID, path: app, relaunch: true },
  viewports: [
    { name: 'wide', width: 900, height: 600 },
    { name: 'compact', width: 640, height: 480 },
  ],
  journeys: [
    {
      id: 'open-atlas',
      goal: 'Open the Atlas project',
      persona: 'A designer',
      ready: {
        kind: 'visible',
        target: { by: 'testId', value: 'nav-projects' },
      },
      success: [
        { kind: 'path', pattern: '^/Project Atlas$' },
        {
          kind: 'text',
          target: { by: 'testId', value: 'project-title' },
          pattern: '^Atlas$',
        },
      ],
      maxSteps: 12,
      maxDurationMs: 60000,
    },
  ],
});
const pick = (actions: Action[]) =>
  actions.find((action) => action.description === 'Press button Atlas') ??
  actions.find(
    (action) => action.kind === 'scroll' && action.direction === 'down',
  ) ??
  actions.find((action) => action.description === 'Press button Projects');
const decisions: Models = {
  async plan() {
    return { objective: 'Open Projects, then Atlas', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    const choice = pick(actions)?.id ?? 'no_match';
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
const directory = resolve(
  `runs/demo-macos-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const results = await runSuite(suite, decisions, { directory });
for (const result of results)
  console.log(
    `${result.status}: ${result.journey}/${result.viewport}: ${result.reason}`,
  );
console.log(`Report: ${directory}/report.html`);
process.exitCode = results.every((result) => result.status === 'passed')
  ? 0
  : 1;
