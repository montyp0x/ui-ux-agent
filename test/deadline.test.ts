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
    audits: { checks: [{ id: 'layout.horizontal-overflow' }] },
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
    'Task budget exhausted before the outcome was observed (choose was cancelled at the deadline)',
  );
  assert.equal(result.outcome.code, 'budget_deadline_abort');
  assert.equal(result.outcome.category, 'budget_exhausted');
  // The journey signal and the request's own timeout both fire at the
  // deadline; either one yields the same code.
  const cut = /Journey deadline reached|aborted due to timeout/;
  assert.match(result.outcome.detail ?? '', cut);
  const [exhausted] = budgetEvents(events);
  assert.equal(exhausted!.data.stage, 'choose');
  assert.equal(exhausted!.data.cause, 'deadline_abort');
  assert.match(String(exhausted!.data.detail), cut);
});

test('every model call gets one journey signal that aborts at the deadline', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  let chooseCalls = 0;
  let hungAt = 0;
  let abortedAt = 0;
  const { result, events } = await run(() => ({
    async plan(_j, _o, _h, _t, _a, _c, signal) {
      signals.push(signal);
      return plan();
    },
    async choose(_j, _o, _p, actions, _h, _t, signal) {
      signals.push(signal);
      if (++chooseCalls < 2) return selected(actions[0]!.id, actions);
      // A model that never answers: only the journey signal ends the call.
      hungAt = Date.now();
      return new Promise<Choice>((_resolve, reject) =>
        signal!.addEventListener('abort', () => {
          abortedAt = Date.now();
          reject(signal!.reason);
        }),
      );
    },
  }));
  // At least one plan and both selector calls.
  assert.ok(signals.length >= 3);
  assert.equal(chooseCalls, 2);
  assert.ok(signals.every((signal) => signal && signal === signals[0]));
  assert.ok(signals[0]!.aborted);
  assert.equal((signals[0]!.reason as Error).name, 'TimeoutError');
  // Ended by the signal at the deadline, not by the call returning.
  assert.ok(hungAt > 0 && abortedAt >= hungAt);
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome.code, 'budget_deadline_abort');
  assert.equal(result.outcome.stage, 'choose');
  assert.equal(result.outcome.detail, 'Journey deadline reached');
  const [exhausted, ...extra] = budgetEvents(events);
  assert.equal(extra.length, 0);
  assert.equal(exhausted!.data.cause, 'deadline_abort');
  assert.ok(Number(exhausted!.data.overrunMs) >= 0);
  assert.ok(
    Number(exhausted!.data.overrunMs) < 1000,
    'stopped at the deadline',
  );
});

test('an abort before the deadline remains an error', async () => {
  const { result, events } = await run(() => ({
    plan,
    async choose() {
      throw new DOMException('The operation was aborted', 'AbortError');
    },
  }));
  assert.equal(result.status, 'error');
  assert.equal(result.outcome.code, 'model_call_failed');
  assert.equal(budgetEvents(events).length, 0);
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
  driver.openSession = async (options) => {
    const session = await open(options);
    // The journey's deadline counts from its start, right after its session
    // opened; run setup before that (slow on CI runners) does not count.
    const opened = Date.now();
    session.execute = async () => {
      await sleep(opened + budgetMs + 300 - Date.now());
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
