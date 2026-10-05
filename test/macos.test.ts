import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suiteSchema, type Action } from '../src/contracts.js';
import { ensureHelper } from '../src/drivers/macos.js';
import {
  buildFixtureApp,
  FIXTURE_BUNDLE_ID,
} from '../src/drivers/macos-fixture.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';

// Native tests need macOS plus Accessibility and Screen Recording permission
// for the process running them; elsewhere (CI on Linux) they are skipped.
async function nativeReady(): Promise<string | false> {
  if (process.platform !== 'darwin') return 'not macOS';
  const helper = await ensureHelper();
  const status = JSON.parse(
    execFileSync(helper, { input: '{"cmd":"status"}\n' }).toString().trim(),
  );
  return status.accessibility && status.screenCapture
    ? false
    : 'Accessibility or Screen Recording permission missing';
}
const skip = await nativeReady();

const suite = (app: string) =>
  suiteSchema.parse({
    name: 'Native fixture',
    platform: 'macos',
    app: { bundleId: FIXTURE_BUNDLE_ID, path: app, relaunch: true },
    viewports: [{ name: 'window', width: 900, height: 600 }],
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

test(
  'a native app journey runs end to end through the macOS driver',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-')),
      'run',
    );
    const offeredDescriptions: string[] = [];
    const pick = (actions: Action[]) =>
      actions.find((action) => action.description === 'Press button Atlas') ??
      actions.find(
        (action) =>
          action.description === 'Press button Projects' &&
          !actions.some((other) => other.kind === 'scroll'),
      ) ??
      actions.find(
        (action) => action.kind === 'scroll' && action.direction === 'down',
      );
    const models: Models = {
      async plan() {
        return { objective: 'Open Projects, then Atlas', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        offeredDescriptions.push(
          ...actions.map((action) => action.description),
        );
        const choice = pick(actions)?.id ?? 'no_match';
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', choice === 'no_match' ? 1 : 0],
          ]),
        };
      },
    };
    const [result] = await runSuite(suite(app), models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    assert.deepEqual(result!.checks, [true, true]);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const actions = events
      .filter((event) => event.event === 'action_result')
      .map((event) => [event.data.action.description, event.data.error]);
    assert.equal(actions[0]![0], 'Press button Projects');
    assert.ok(
      actions.some(([description]) =>
        String(description).startsWith('Scroll down in Project list'),
      ),
    );
    assert.deepEqual(actions.at(-1), ['Press button Atlas', null]);
    // Atlas is only offered once scrolled into the visible list area.
    assert.ok(
      offeredDescriptions.indexOf('Press button Atlas') >
        offeredDescriptions.indexOf('Press button Apollo'),
    );
    assert.ok(result!.trace.endsWith('.json'));
    const screenshot = await readFile(
      join(directory, 'open-atlas-window', 'final.png'),
    );
    assert.ok(screenshot.length > 1000);
  },
);

test(
  'destructive controls are never offered in native apps',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-block-')),
      'run',
    );
    const seen: string[] = [];
    const models: Models = {
      async plan() {
        return { objective: 'Open Settings', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        seen.push(...actions.map((action) => action.description));
        const choice =
          actions.find(
            (action) => action.description === 'Press button Settings',
          )?.id ?? actions.find((action) => action.kind === 'wait')!.id;
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', 0],
          ]),
        };
      },
    };
    const blocked = suiteSchema.parse({
      ...suite(app),
      journeys: [{ ...suite(app).journeys[0]!, maxSteps: 3 }],
    });
    await runSuite(blocked, models, { directory });
    assert.ok(seen.includes('Press checkbox Compact layout'));
    assert.ok(!seen.some((description) => /Delete all data/.test(description)));
    const skipped = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.event === 'candidate_skipped' &&
          event.data.reason === 'blocked',
      )
      .map((event) => event.data.name);
    assert.ok(skipped.includes('Delete all data'));
  },
);

test(
  'scrolling a SwiftUI list advances page by page in a compact window',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-compact-')),
      'run',
    );
    const compact = suiteSchema.parse({
      ...suite(app),
      viewports: [{ name: 'compact', width: 640, height: 480 }],
    });
    const models: Models = {
      async plan() {
        return { objective: 'Open Projects, then Atlas', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        const choice = (actions.find(
          (action) => action.description === 'Press button Atlas',
        ) ??
          actions.find(
            (action) => action.kind === 'scroll' && action.direction === 'down',
          ) ??
          actions.find(
            (action) => action.description === 'Press button Projects',
          ))!.id;
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', 0],
          ]),
        };
      },
    };
    const [result] = await runSuite(compact, models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const positions = events
      .filter(
        (event) =>
          event.event === 'observation' && event.data.url.endsWith('/Projects'),
      )
      .map((event) => event.data.scroll.containers[0]?.y ?? 0);
    // Each scroll moved further down; none jumped back to the top.
    assert.ok(positions.length >= 3);
    for (let index = 1; index < positions.length; index++)
      assert.ok(
        positions[index] > positions[index - 1],
        JSON.stringify(positions),
      );
  },
);
