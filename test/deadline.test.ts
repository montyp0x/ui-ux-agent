import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suiteSchema, type Action, type Choice } from '../src/contracts.js';
import { models, type Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import { playwrightDriver } from '../src/drivers/playwright.js';
import type { UIDriver } from '../src/drivers/types.js';

const budgetMs = 3000;
type Event = { event: string; data: Record<string, unknown> };

function selected(choice: string, actions: Action[]): Choice {
  return {
    type: 'choice',
    choice,
    confidence: 1,
    probabilities: Object.fromEntries([
      ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
      ['no_match', 0],
    ]),
  };
}

const plan = async () => ({ objective: 'Open Next', concerns: [] });
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function run(build: (selectorURL: string) => Models, driver?: UIDriver) {
  const server = createServer((request, response) => {
    // The selector endpoint never answers: only the caller's deadline ends it.
    if (request.url === '/selector') return;
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>Deadline fixture</h1><a href="/next">Next</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-deadline-')),
    'run',
  );
  const suite = suiteSchema.parse({
    name: 'LOCAL deadline fixture',
    baseURL: url,
    requiresAuth: false,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [
      {
        id: 'deadline',
        goal: 'Reach Done',
        persona: 'A first-time user',
        startPath: '/',
        allowedPaths: ['/', '/next'],
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Deadline fixture' },
        },
        success: [{ kind: 'path', pattern: '^/done$' }],
        maxSteps: 20,
        maxDurationMs: budgetMs,
      },
    ],
  });
  try {
    const [result] = await runSuite(suite, build(`${url}/selector`), {
      directory,
      driver,
    });
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Event);
    return { result: result!, events };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const budgetEvents = (events: Event[]) =>
  events.filter((entry) => entry.event === 'budget_exhausted');

test('a planner that answers after the deadline fails the budget without calling the selector', async () => {
  let deadline = 0;
  let chooseCalls = 0;
  const { result, events } = await run(() => ({
    async plan(_journey, _observation, _history, timeoutMs) {
      deadline = Date.now() + timeoutMs;
      await sleep(timeoutMs + 300);
      return plan();
    },
    async choose(_j, _o, _p, actions) {
      chooseCalls++;
      return selected(actions[0]!.id, actions);
    },
  }));
  assert.ok(deadline > 0);
  assert.equal(chooseCalls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(
    result.reason,
    'Task budget exhausted before the outcome was observed (deadline reached before choose)',
  );
  assert.equal(result.outcome.code, 'budget_deadline_before_stage');
  assert.equal(result.outcome.stage, 'choose');
  assert.deepEqual(result.outcome.evidence.events, ['budget_exhausted']);
  assert.ok(
    !result.findings.some((finding) => finding.category === 'action-error'),
  );
  const [exhausted, ...extra] = budgetEvents(events);
  assert.equal(extra.length, 0);
  assert.equal(exhausted!.data.stage, 'choose');
  assert.equal(exhausted!.data.cause, 'deadline_before_stage');
  assert.equal(exhausted!.data.detail, null);
  assert.ok(Number(exhausted!.data.overrunMs) >= 0);
});

test('a selector HTTP call aborted by the journey deadline is a budget failure, not an error', async () => {
  const { result, events } = await run((selectorURL) => ({
    ...models({
      plannerURL: '',
      plannerKey: '',
      plannerModel: 'unused',
      selectorURL,
      selectorKey: 'local',
      selectorModel: 'local',
    }),
    plan,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(
    result.reason,
    'Task budget exhausted before the outcome was observed (choose timed out at the deadline)',
  );
  assert.equal(result.outcome.code, 'budget_stage_timeout');
  assert.match(result.outcome.detail ?? '', /aborted due to timeout/);
  const [exhausted] = budgetEvents(events);
  assert.equal(exhausted!.data.stage, 'choose');
  assert.equal(exhausted!.data.cause, 'timeout');
  assert.match(String(exhausted!.data.detail), /aborted due to timeout/);
});

test('a timeout before the deadline remains an error', async () => {
  const { result, events } = await run(() => ({
    plan,
    async choose() {
      throw new DOMException('Selector gave up early', 'TimeoutError');
    },
  }));
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'Selector gave up early');
  assert.equal(result.outcome.code, 'model_call_failed');
  assert.equal(budgetEvents(events).length, 0);
});

test('a non-timeout failure at the deadline remains an error', async () => {
  const { result, events } = await run(() => ({
    plan,
    async choose(_j, _o, _p, _a, _h, timeoutMs) {
      await sleep(timeoutMs + 100);
      throw new Error('Selector response was malformed');
    },
  }));
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'Selector response was malformed');
  assert.equal(result.outcome.code, 'model_call_failed');
  assert.equal(budgetEvents(events).length, 0);
});

test('an action cut off by the deadline is not reported as a UI action error', async () => {
  const driver = await playwrightDriver('chromium', true);
  const open = driver.openSession.bind(driver);
  const started = Date.now();
  driver.openSession = async (options) => {
    const session = await open(options);
    session.execute = async () => {
      await sleep(started + budgetMs + 300 - Date.now());
      throw Object.assign(new Error('locator.click: Timeout exceeded'), {
        name: 'TimeoutError',
      });
    };
    return session;
  };
  const { result } = await run(
    () => ({
      plan,
      async choose(_j, _o, _p, actions) {
        return selected(
          actions.find((action) => action.kind === 'link')!.id,
          actions,
        );
      },
    }),
    driver,
  );
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /^Task budget exhausted/);
  assert.equal(result.steps, 1);
  assert.ok(
    !result.findings.some((finding) => finding.category === 'action-error'),
  );
});
