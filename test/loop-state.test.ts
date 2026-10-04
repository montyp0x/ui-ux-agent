import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suiteSchema } from '../src/contracts.js';
import { playwrightDriver } from '../src/drivers/playwright.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';

type Scenario =
  | 'background'
  | 'rebind'
  | 'rebind-fallback'
  | 'toggle'
  | 'cycle'
  | 'progress'
  | 'unsupported-progress'
  | 'ambiguous-progress'
  | 'wait'
  | 'blocked-scroll'
  | 'scroll';
async function fixtureRun(scenario: Scenario) {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><h1>Loop fixture</h1>
      <button aria-expanded="false" onclick="${scenario === 'background' ? "document.querySelector('#clock').textContent = 'Background ' + ++window.count" : scenario === 'toggle' || scenario === 'cycle' ? "this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') === 'false' ? 'true' : 'false'); if (++window.count === 2 && " + (scenario === 'toggle' ? 'true' : 'false') + ") document.querySelector('#outcome').textContent = 'Done'" : scenario === 'progress' ? "document.querySelector('#progress').textContent = 'Page ' + ++window.count; if(window.count === 4) document.querySelector('#outcome').textContent = 'Done'" : ''}">Continue</button>
      <p id="clock">Background 0</p><p id="progress">Page 0</p>
      <p id="outcome" style="${scenario === 'scroll' ? 'position:fixed;bottom:0;background:white' : ''}">Working</p>
      ${scenario === 'blocked-scroll' || scenario === 'scroll' ? '<div style="height:5000px"></div>' : ''}
      <script>window.count = 0;
      ${scenario === 'wait' ? "setTimeout(() => document.querySelector('#outcome').textContent = 'Done', 1800);" : ''}
      ${scenario === 'blocked-scroll' ? "addEventListener('wheel', event => { event.preventDefault(); document.querySelector('#clock').textContent = 'Background ' + ++window.count; }, {passive:false});" : ''}
      ${scenario === 'scroll' ? "addEventListener('scroll', () => { if (document.scrollingElement.scrollTop >= 1800) document.querySelector('#outcome').textContent = 'Done'; });" : ''}
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-loop-')), 'run');
  const driver = await playwrightDriver('chromium', true);
  if (
    ['rebind', 'rebind-fallback', 'unsupported-progress'].includes(scenario)
  ) {
    const open = driver.openSession.bind(driver);
    driver.openSession = async (options) => {
      const session = await open(options);
      if (scenario !== 'rebind') delete session.repeatState;
      const candidates = session.candidates.bind(session);
      let iteration = 0;
      session.candidates = async () => {
        const actions = await candidates();
        for (const [index, action] of actions.entries())
          action.id = `binding-${iteration}-${index}`;
        iteration++;
        return actions;
      };
      return session;
    };
  }
  const models: Models = {
    async plan() {
      return { objective: 'Continue until Done', concerns: [] };
    },
    async choose(_j, _o, _p, actions) {
      const choice = actions.find((action) =>
        scenario === 'wait'
          ? action.kind === 'wait'
          : scenario === 'blocked-scroll' || scenario === 'scroll'
            ? action.kind === 'scroll' && action.direction === 'down'
            : action.kind === 'click',
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
        name: 'Local loop regression',
        baseURL: `http://127.0.0.1:${address.port}`,
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        journeys: [
          {
            id: 'continue',
            goal: 'Reach Done',
            persona: 'Visitor',
            startPath: '/',
            allowedPaths: ['/'],
            ready: {
              kind: 'visible',
              target: { by: 'role', role: 'heading', name: 'Loop fixture' },
            },
            success: [
              {
                kind: 'text',
                target: { by: 'css', value: '#outcome' },
                pattern: '^Done$',
              },
            ],
            interactions: [
              {
                kind: 'click',
                target: { by: 'role', role: 'button', name: 'Continue' },
                description: 'Continue',
              },
            ],
            ...([
              'progress',
              'unsupported-progress',
              'ambiguous-progress',
            ].includes(scenario)
              ? {
                  loopProgressTargets: [
                    {
                      by: 'css',
                      value:
                        scenario === 'ambiguous-progress' ? 'p' : '#progress',
                    },
                  ],
                }
              : {}),
            maxSteps: 8,
            maxDurationMs: 10000,
          },
        ],
      }),
      models,
      { directory, driver },
    );
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return { result: results[0]!, events };
  } finally {
    await driver.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const scenario of ['background', 'rebind', 'blocked-scroll'] as const) {
  test(`${scenario} cannot disguise repeated actions with unchanged recipient state`, async () => {
    const { result, events } = await fixtureRun(scenario);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /Repeated/);
    assert.equal(result.steps, 2);
    assert.ok(result.findings.some((finding) => finding.category === 'loop'));
    const checks = events.filter((event) => event.event === 'loop_check');
    // The first revisit asks the planner once; the third dispatch is still rejected.
    assert.deepEqual(
      checks.map((event) => [event.data.visits, event.data.outcome]),
      [
        [1, 'dispatch'],
        [2, 'replan'],
        [2, 'dispatch'],
        [3, 'rejected'],
      ],
    );
    assert.equal(new Set(checks.map((event) => event.data.key)).size, 1);
    assert.equal(
      events.filter(
        (event) =>
          event.event === 'plan' &&
          event.data.refreshReasons.includes('revisited-state'),
      ).length,
      1,
    );
    if (scenario !== 'rebind') {
      const fingerprints = events
        .filter((event) => event.event === 'observation')
        .map((event) => event.data.fingerprint);
      assert.ok(
        new Set(fingerprints).size >= 3,
        'Unrelated content really changed',
      );
    }
  });
}

test('reversible controls with different local states remain usable', async () => {
  const { result } = await fixtureRun('toggle');
  assert.equal(result.status, 'passed');
  assert.equal(result.steps, 2);
});

test('suite-declared progress outside the selected control permits legitimate repeated actions', async () => {
  const { result } = await fixtureRun('progress');
  assert.equal(result.status, 'passed');
  assert.equal(result.steps, 4);
});

test('scroll position changes distinguish legitimate repeated wheel actions', async () => {
  const { result, events } = await fixtureRun('scroll');
  assert.equal(result.status, 'passed');
  assert.ok(result.steps >= 3);
  const checks = events.filter((event) => event.event === 'loop_check');
  assert.equal(
    new Set(checks.map((event) => event.data.key)).size,
    checks.length,
  );
});

test('a reversible cycle is bounded only after repeated visits to the same local state', async () => {
  const { result, events } = await fixtureRun('cycle');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Repeated/);
  assert.equal(result.steps, 4);
  assert.deepEqual(
    events
      .filter((event) => event.event === 'loop_check')
      .map((event) => [event.data.visits, event.data.outcome]),
    [
      [1, 'dispatch'],
      [1, 'dispatch'],
      [2, 'replan'],
      [2, 'dispatch'],
      [2, 'replan'],
      [2, 'dispatch'],
      [3, 'rejected'],
    ],
  );
});

test('custom drivers without recipient state still normalize candidate IDs in the page-state fallback', async () => {
  const { result, events } = await fixtureRun('rebind-fallback');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Repeated/);
  assert.equal(result.steps, 2);
  assert.ok(
    events
      .filter((event) => event.event === 'loop_check')
      .every((event) => event.data.stateSource === 'page-fallback'),
  );
});

for (const [scenario, reason] of [
  ['unsupported-progress', /implement repeatState/],
  ['ambiguous-progress', /ambiguous/],
] as const) {
  test(`${scenario} is reported rather than silently discarding configured progress`, async () => {
    const { result } = await fixtureRun(scenario);
    assert.equal(result.status, 'error');
    assert.match(result.reason, reason);
  });
}

test('waiting for asynchronous content is limited by task budgets, not repeated-state rejection', async () => {
  const { result } = await fixtureRun('wait');
  assert.equal(result.status, 'passed');
  assert.ok(result.steps >= 3);
});
