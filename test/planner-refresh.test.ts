import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suiteSchema, type Action } from '../src/contracts.js';
import { actionSignature, refreshReasons } from '../src/planning.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';

async function menuRun(change: 'actions' | 'background') {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      request.url === '/library'
        ? '<h1>Library</h1>'
        : `
      <h1>Directory</h1><button onclick="const menu = document.querySelector('nav'); menu.hidden = !menu.hidden;">Browse</button>
      <nav hidden><a href="/library">Library</a></nav><p id="clock">Tick 0</p>
      ${change === 'background' ? '<script>setInterval(() => document.querySelector("#clock").textContent = "Tick " + Date.now(), 30)</script>' : ''}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-planner-')),
    'run',
  );
  let planCalls = 0;
  const objectives: string[] = [];
  const models: Models = {
    async plan(_journey, observation, _history, _timeoutMs, actions) {
      planCalls++;
      assert.ok(actions?.length, 'The planner receives executable candidates');
      const hasLibrary = actions.some(
        (action) =>
          action.kind === 'link' && action.description === 'Open Library',
      );
      assert.equal(
        hasLibrary,
        observation.visibleViewport.controls.some(
          (control) => control.name === 'Library',
        ),
      );
      const objective = hasLibrary ? 'Open Library' : 'Expand Browse';
      objectives.push(objective);
      return { objective, concerns: [] };
    },
    async choose(_j, _o, plan, actions) {
      const choice =
        change === 'background'
          ? actions.find((action) => action.kind === 'wait')!.id
          : actions.find(
              (action) =>
                action.kind ===
                (plan.objective === 'Open Library' ? 'link' : 'click'),
            )!.id;
      return {
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: Object.fromEntries([
          ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
          ['no_match', 0],
        ]),
      };
    },
  };
  try {
    const results = await runSuite(
      suiteSchema.parse({
        name: 'Planner refresh fixture',
        baseURL: `http://127.0.0.1:${address.port}`,
        viewports: [{ name: 'narrow', width: 390, height: 844 }],
        journeys: [
          {
            id: 'library',
            goal: 'Find the Library',
            persona: 'Visitor',
            startPath: '/',
            allowedPaths: ['/', '/library'],
            ready: {
              kind: 'visible',
              target: { by: 'role', role: 'heading', name: 'Directory' },
            },
            success: [{ kind: 'path', pattern: '^/library$' }],
            interactions: [
              {
                kind: 'click',
                target: { by: 'role', role: 'button', name: 'Browse' },
                description: 'Expand Browse',
              },
            ],
            maxSteps: 2,
            maxDurationMs: 10000,
          },
        ],
      }),
      models,
      { directory },
    );
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return { result: results[0]!, events, planCalls, objectives };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('planning signatures ignore candidate rebinding, ordering and wheel coordinates but preserve action meaning', () => {
  const link: Action = {
    kind: 'link',
    id: 'a0',
    description: 'Open Library',
    target: { by: 'role', role: 'link', name: 'Library' },
    href: '/library',
  };
  const scroll: Action = {
    kind: 'scroll',
    id: 'a1',
    description: 'Scroll down in main',
    direction: 'down',
    region: 's0',
    point: { x: 100, y: 200 },
  };
  const signature = actionSignature([link, scroll]);
  assert.equal(
    signature,
    actionSignature([
      { ...scroll, id: 'a5', point: { x: 50, y: 300 } },
      { ...link, id: 'a4' },
    ]),
  );
  assert.notEqual(
    signature,
    actionSignature([{ ...link, href: '/other' }, scroll]),
  );
  assert.notEqual(
    signature,
    actionSignature([link, { ...scroll, region: 's1' }]),
  );
  assert.notEqual(signature, actionSignature([link]));
});

test('navigation includes query and hash; cadence counts from the last refresh; errors force reconsideration', () => {
  const previous = {
    url: 'https://example.test/?view=one#summary',
    actions: 'same',
    step: 4,
  };
  assert.deepEqual(
    refreshReasons(true, previous, { ...previous, step: 5 }, []),
    [],
  );
  assert.deepEqual(
    refreshReasons(true, previous, { ...previous, step: 9 }, []),
    ['periodic'],
  );
  for (const url of [
    'https://example.test/?view=two#summary',
    'https://example.test/?view=one#details',
  ]) {
    assert.deepEqual(
      refreshReasons(true, previous, { ...previous, url, step: 5 }, []),
      ['navigation'],
    );
  }
  assert.deepEqual(
    refreshReasons(true, previous, { ...previous, step: 5 }, [
      { action: 'Open', changed: true, error: 'Stale observation' },
    ]),
    ['action-error'],
  );
  assert.deepEqual(
    refreshReasons(true, previous, { ...previous, step: 5 }, [
      { action: 'Open', changed: false, error: null },
    ]),
    ['no-progress'],
  );
  assert.deepEqual(
    refreshReasons(false, previous, { ...previous, step: 5 }, []),
    ['selector-no-match'],
  );
  assert.deepEqual(refreshReasons(false, null, previous, []), ['initial']);
});

test('newly offered navigation invalidates the expand-menu objective before the selector can toggle it closed', async () => {
  const { result, planCalls, objectives, events } = await menuRun('actions');
  assert.equal(result.status, 'passed');
  assert.equal(result.steps, 2);
  assert.equal(planCalls, 2);
  assert.deepEqual(objectives, ['Expand Browse', 'Open Library']);
  assert.deepEqual(
    events
      .filter((event) => event.event === 'plan')
      .map((event) => event.data.refreshReasons),
    [['initial'], ['available-actions']],
  );
  const actions = events.filter((event) => event.event === 'action_result');
  assert.deepEqual(
    actions.map((event) => event.data.action.kind),
    ['click', 'link'],
  );
});

test('background content updates alone do not trigger extra planning', async () => {
  const { result, planCalls } = await menuRun('background');
  assert.equal(result.status, 'failed');
  assert.equal(result.steps, 2);
  assert.equal(planCalls, 1);
});
