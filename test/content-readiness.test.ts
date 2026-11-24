import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { check } from '../src/browser.js';
import { suiteSchema } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';

// Loaded states render their content 1.5 s after the page: later than the
// first readiness check even on a slow CI machine (Windows runners took over
// 900 ms), and well inside the 3 s readiness timeout.
async function run(state: string, content = true, duration = 8000) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/unauthorized') {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    response.end(
      request.url === '/'
        ? '<h1>Fixture</h1><a href="/detail">Open detail</a>'
        : `
      <h1>Detail</h1><div data-testid="tabs">Overview</div>
      <main><p data-testid="loading">Loading</p></main>
      ${state === 'unauthorized' ? '<script>setTimeout(() => fetch("/unauthorized"), 400)</script>' : ''}
      ${
        state === 'loading' || state === 'unauthorized'
          ? ''
          : `<script>setTimeout(() => {
        document.querySelector('main').innerHTML = ${JSON.stringify(state === 'error' ? '<p data-testid="error">Unavailable</p>' : state === 'empty' ? '<p data-testid="empty">No captured instruction available.</p>' : '<p data-testid="content">Captured instruction: inspect the changes.</p>')};
        ${state === 'shifted' ? `const spacer = document.createElement('div'); spacer.style.height = '1200px'; document.body.append(spacer, document.querySelector('[data-testid="tabs"]'));` : ''}
      }, 1500)</script>`
      }`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-readiness-')),
    'run',
  );
  let choices = 0;
  const models: Models = {
    async plan() {
      return { objective: 'Open detail', concerns: [] };
    },
    async choose(_j, _o, _p, actions) {
      choices++;
      const choice = (actions.find((action) => action.kind === 'link') ??
        actions.find(
          (action) => action.kind === 'scroll' && action.direction === 'down',
        ))!.id;
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
    const suite = suiteSchema.parse({
      name: 'Content fixture',
      baseURL: `http://127.0.0.1:${address.port}`,
      viewports: [{ name: 'narrow', width: 390, height: 844 }],
      audits: { checks: [{ id: 'layout.horizontal-overflow' }] },
      journeys: [
        {
          id: 'detail',
          goal: 'Inspect loaded detail',
          persona: 'Visitor',
          startPath: '/',
          allowedPaths: ['/', '/detail'],
          ready: {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Fixture' },
          },
          success: [
            { kind: 'path', pattern: '^/detail$' },
            { kind: 'visible', target: { by: 'testId', value: 'tabs' } },
          ],
          ...(content
            ? {
                contentReady: {
                  timeoutMs: 3000,
                  checks: [
                    {
                      kind: 'anyRendered',
                      target: {
                        by: 'css',
                        value: '[data-testid="content"], [data-testid="empty"]',
                      },
                    },
                    {
                      kind: 'notVisible',
                      target: { by: 'testId', value: 'loading' },
                    },
                    {
                      kind: 'notVisible',
                      target: { by: 'testId', value: 'error' },
                    },
                  ],
                },
              }
            : {}),
          maxSteps: state === 'shifted' ? 4 : 1,
          maxDurationMs: duration,
        },
      ],
    });
    const results = await runSuite(suite, models, { directory });
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return { result: results[0]!, events, choices };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('anyRendered checks layout presence, not viewport inspection, and rejects hidden content', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div style="height:2000px"></div><p data-testid="content">Loaded</p>',
    );
    const target = { by: 'testId' as const, value: 'content' };
    assert.equal(await check(page, { kind: 'anyRendered', target }), true);
    assert.equal(await check(page, { kind: 'anyVisible', target }), false);
    await page.getByTestId('content').evaluate((element) => {
      element.style.display = 'none';
    });
    assert.equal(await check(page, { kind: 'anyRendered', target }), false);
  } finally {
    await browser.close();
  }
});

test('content configuration rejects empty checks and malformed regexes', () => {
  const base = {
    name: 'Validation',
    baseURL: 'http://localhost',
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [
      {
        id: 'detail',
        goal: 'Inspect',
        persona: 'Visitor',
        startPath: '/',
        allowedPaths: ['/'],
        ready: { kind: 'path', pattern: '^/$' },
        success: [{ kind: 'path', pattern: '^/$' }],
      },
    ],
  };
  for (const checks of [
    [],
    [
      {
        kind: 'text',
        target: { by: 'testId', value: 'content' },
        pattern: '[',
      },
    ],
  ]) {
    assert.throws(() =>
      suiteSchema.parse({
        ...base,
        journeys: [{ ...base.journeys[0], contentReady: { checks } }],
      }),
    );
  }
});

test('arrival-only assertions reproduce a loading-shell false pass', async () => {
  const { result } = await run('loading', false);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.checks, [true, true]);
});

test('persistent loading fails with explicit timeout evidence, not an arrival pass', async () => {
  const { result, events, choices } = await run('loading');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Content readiness timed out/);
  assert.deepEqual(result.checks, [true, true, false, false, true]);
  // The content assertions were evaluated within their own timeout and did not hold.
  assert.equal(result.outcome.code, 'content_readiness_timeout');
  assert.equal(result.outcome.source, 'assertion');
  assert.deepEqual(result.outcome.evidence.failedChecks, [2, 3]);
  assert.equal(choices, 1);
  assert.ok(
    events.some(
      (event) =>
        event.event === 'content_readiness' &&
        event.data.outcome === 'timeout' &&
        event.data.failedChecks.length === 2,
    ),
  );
});

for (const state of ['loaded', 'empty']) {
  test(`${state} content passes after asynchronous loading even on the last action`, async () => {
    const { result, events, choices } = await run(state);
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.checks, [true, true, true, true, true]);
    assert.equal(result.steps, 1);
    assert.equal(choices, 1);
    assert.ok(
      events.some(
        (event) =>
          event.event === 'content_readiness' &&
          event.data.outcome === 'waiting',
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.event === 'content_readiness' &&
          event.data.outcome === 'passed',
      ),
    );
  });
}

test('loading-induced layout shift refreshes observations and permits scrolling back to arrival controls', async () => {
  const { result, events, choices } = await run('shifted');
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.checks, [true, true, true, true, true]);
  assert.ok(choices > 1);
  assert.ok(
    events.some(
      (event) =>
        event.event === 'action_result' && event.data.action.kind === 'scroll',
    ),
  );
  assert.ok(events.some((event) => event.event === 'content_observation'));
});

test('unavailable content does not qualify as a loaded or accepted empty state', async () => {
  const { result } = await run('error');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.checks, [true, true, false, true, false]);
});

test('an unauthorized response during content waiting blocks completion', async () => {
  const { result, events } = await run('unauthorized');
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /401/);
  assert.equal(result.outcome.code, 'unauthorized_response');
  assert.ok(
    events.some(
      (event) =>
        event.event === 'content_readiness' &&
        event.data.outcome === 'unauthorized',
    ),
  );
});

test('content waiting is capped by the overall journey deadline', async () => {
  const { result, events } = await run('loading', true, 1000);
  assert.equal(result.status, 'failed');
  const timeout = events.find(
    (event) =>
      event.event === 'content_readiness' && event.data.outcome === 'timeout',
  );
  assert.ok(timeout);
  assert.equal(timeout.data.budget, 'journey');
  // Cut short by the journey deadline: a budget outcome, not an assertion failure.
  assert.equal(result.outcome.code, 'budget_deadline');
  assert.equal(result.outcome.category, 'budget_exhausted');
  assert.ok(timeout.data.durationMs < 1300);
});
