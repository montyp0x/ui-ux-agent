import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
  allowedRequest,
  allowedURL,
  candidates,
  execute,
  observe,
} from '../src/browser.js';
import {
  planSchema,
  suiteSchema,
  type Action,
  type Choice,
  type Journey,
} from '../src/contracts.js';
import {
  models,
  parseStructured,
  portableSchema,
  validateChoice,
  type Models,
} from '../src/models.js';
import { reportHTML } from '../src/report.js';
import { runSuite } from '../src/runner.js';
import { starterSuite } from '../src/scaffold.js';

const journey: Journey = {
  id: 'session-discovery',
  goal: 'Find the recent session and inspect its result',
  persona: 'A first-time team lead',
  startPath: '/',
  allowedPaths: ['/', '/sessions'],
  ready: {
    kind: 'visible',
    target: { by: 'role', role: 'heading', name: 'Local harness fixture' },
  },
  success: [
    { kind: 'path', pattern: '^/sessions/example$' },
    {
      kind: 'text',
      target: { by: 'testId', value: 'session-result' },
      pattern: 'Completed',
    },
  ],
  interactions: [],
  discoverRoles: [],
  maxSteps: 6,
  maxDurationMs: 15000,
};
const base = {
  name: 'LOCAL fixture — browser runner verification',
  baseURL: 'http://127.0.0.1:1',
  requiresAuth: false,
  viewports: [{ name: 'desktop', width: 1280, height: 800 }],
  journeys: [journey],
};
const selected = (choice: string, actions: Action[]): Choice => ({
  type: 'choice',
  choice,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
    ['no_match', choice === 'no_match' ? 1 : 0],
  ]),
});
const deterministic: Models = {
  async plan() {
    return { objective: 'Open the visible session link', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return selected(
      actions.find((action) => action.kind === 'link')?.id ?? 'no_match',
      actions,
    );
  },
};

async function body(request: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of request) data += String(chunk);
  return JSON.parse(data);
}

async function fixture() {
  const requests: { method: string; path: string }[] = [];
  const plannerGateway: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? '/';
    requests.push({ method: request.method ?? 'GET', path });
    if (path === '/planner') {
      plannerGateway.push(request.headers['x-planner-gateway'] as string);
      const payload = (await body(request)) as {
        max_completion_tokens?: number;
        max_tokens?: number;
        response_format: { type: string; json_schema: { schema: unknown } };
        messages: {
          content:
            | string
            | { type: string; text?: string; image_url?: { url: string } }[];
        }[];
      };
      // Current Chat Completions shape: max_completion_tokens and a json_schema
      // carrying only structure; value limits are enforced by the Zod parse.
      assert.equal(payload.max_completion_tokens, 1200);
      assert.equal(payload.max_tokens, undefined);
      assert.equal(payload.response_format.type, 'json_schema');
      assert.doesNotMatch(
        JSON.stringify(payload.response_format.json_schema.schema),
        /maxItems|minLength|\$schema/,
      );
      assert.ok(Array.isArray(payload.messages[1]?.content));
      const content = payload.messages[1]?.content;
      if (Array.isArray(content)) {
        assert.ok(
          content.some((part) =>
            part.image_url?.url.startsWith('data:image/png;base64,'),
          ),
        );
        const plannerInput = JSON.parse(
          content.find((part) => part.type === 'text')!.text!,
        );
        assert.ok(Array.isArray(plannerInput.refresh.reasons));
        assert.ok(
          plannerInput.availableActions.some(
            (action: { kind: string }) => action.kind === 'link',
          ),
        );
        assert.ok(
          plannerInput.availableActions.every(
            (action: Record<string, unknown>) =>
              Object.keys(action).sort().join(',') === 'description,id,kind',
          ),
        );
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  objective: 'Inspect the recent session',
                  concerns: [],
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    if (path === '/selector') {
      const payload = (await body(request)) as {
        questions: {
          action: { type: string; criteria: Record<string, string> };
        };
      };
      assert.equal(payload.questions.action.type, 'choice');
      const criteria = payload.questions.action.criteria;
      const choice =
        Object.entries(criteria).find(([, description]) =>
          description.startsWith('Open '),
        )?.[0] ?? 'no_match';
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          answers: {
            action: {
              type: 'choice',
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(criteria).map((key) => [
                  key,
                  key === choice ? 1 : 0,
                ]),
              ),
            },
          },
        }),
      );
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (path === '/blocked-scroll') {
      response.end(
        '<h1>Local harness fixture</h1><a href="/sessions">Sessions</a><div style="height:3000px">Summary cards</div><script>addEventListener("wheel", event => event.preventDefault(), { passive: false });</script>',
      );
      return;
    }
    if (path === '/scroll' || path === '/long-scroll') {
      response.end(
        `<!doctype html><html><h1>Local harness fixture</h1><main><div style="height:${path === '/scroll' ? 1300 : 8000}px">Summary cards</div><a href="/sessions/example">Inspect recent session</a></main></html>`,
      );
      return;
    }
    response.end(
      `<!doctype html><html lang="en"><title>Local runner fixture</title><style>body{font:18px system-ui;max-width:900px;margin:64px auto;padding:24px;background:#f2f4f8;color:#18223a}nav,a,button{margin:12px}main{background:white;padding:32px;border-radius:16px}button{font:inherit;padding:8px}</style><h1>Local harness fixture</h1><main>${path === '/sessions/example' ? '<h2>Session outcome</h2><p data-testid="session-result">Completed: test output is visible.</p>' : path === '/sessions' ? '<h2>Recent sessions</h2><a href="/sessions/example">Inspect recent session</a>' : path === '/broken' ? '<h2>No-op regression</h2><button aria-label="Open session">Open session</button>' : '<h2>Team activity</h2><a href="/sessions">Sessions</a>'}</main></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    plannerGateway,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function output(name: string) {
  const parent = await mkdtemp(join(tmpdir(), 'ui-ux-agent-'));
  return join(parent, name);
}

test('scope rejects external links, auth paths, prefix collisions and encoded traversal', () => {
  assert.equal(
    allowedURL('/sessions/example', base.baseURL, journey.allowedPaths),
    true,
  );
  for (const url of [
    'https://evil.example/sessions',
    '/sessions-archive',
    '/auth/login',
    '//evil.example/',
    '/sessions/%2e%2e/admin',
  ])
    assert.equal(
      allowedURL(url, base.baseURL, journey.allowedPaths),
      false,
      url,
    );
});

test('request guard allows explicit read-only POST endpoints and blocks every other write', () => {
  const suite = suiteSchema.parse({
    ...base,
    readOnlyPosts: [{ origin: 'https://api.example', path: '/search' }],
  });
  assert.equal(
    allowedRequest(
      { method: () => 'POST', url: () => 'https://api.example/search?q=hello' },
      suite,
    ),
    true,
  );
  for (const [method, url] of [
    ['DELETE', 'https://api.example/search'],
    ['POST', 'https://api.example/search/delete'],
    ['POST', 'https://other.example/search'],
  ])
    assert.equal(
      allowedRequest({ method: () => method!, url: () => url! }, suite),
      false,
    );
});

test('selector output must cover exactly the offered actions plus no_match', () => {
  const actions: Action[] = [{ kind: 'wait', id: 'a0', description: 'Wait' }];
  assert.equal(validateChoice(selected('a0', actions), actions).choice, 'a0');
  assert.throws(() =>
    validateChoice(
      { ...selected('a0', actions), choice: 'execute_arbitrary_script' },
      actions,
    ),
  );
  assert.throws(() =>
    validateChoice(
      { ...selected('a0', actions), probabilities: { a0: 0.1, no_match: 0.1 } },
      actions,
    ),
  );
});

test('a real browser reaches all assertions through the planner and selector HTTP adapters', async () => {
  const app = await fixture();
  const directory = process.env.UI_UX_SMOKE_OUT ?? (await output('success'));
  try {
    const integration = models({
      plannerURL: `${app.url}/planner`,
      plannerKey: 'test-only',
      plannerModel: 'fixture-planner',
      selectorURL: `${app.url}/selector`,
      selectorKey: 'test-only',
      selectorModel: 'fixture-selector',
      plannerHeaders: { 'X-Planner-Gateway': 'fixture' },
    });
    const results = await runSuite(
      suiteSchema.parse({ ...base, baseURL: app.url }),
      integration,
      { directory, video: true },
    );
    assert.ok(app.plannerGateway.length > 0);
    assert.ok(app.plannerGateway.every((value) => value === 'fixture'));
    assert.equal(results[0]?.status, 'passed');
    assert.equal(results[0]?.steps, 2);
    assert.deepEqual(results[0]?.checks, [true, true]);
    assert.ok(results[0]?.video);
    assert.ok(
      (
        await readFile(
          join(directory, 'session-discovery-desktop', 'trace.zip'),
        )
      ).length > 100,
    );
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.ok(events.includes('decision'));
    assert.ok(!events.includes('Bearer test-only'));
    assert.ok(
      app.requests.some((request) => request.path === '/sessions/example'),
    );
    console.log(`Local browser evidence: ${directory}/report.html`);
  } finally {
    await app.close();
  }
});

test('repeated no-op clicks fail the task instead of inventing success', async () => {
  const app = await fixture();
  try {
    const broken = {
      ...journey,
      startPath: '/broken',
      allowedPaths: ['/broken', '/sessions'],
      interactions: [
        {
          kind: 'click',
          target: { by: 'role', role: 'button', name: 'Open session' },
          description: 'Open session',
        },
      ],
    };
    const chooser: Models = {
      ...deterministic,
      async choose(_j, _o, _p, actions) {
        return selected(
          actions.find((action) => action.kind === 'click')!.id,
          actions,
        );
      },
    };
    const results = await runSuite(
      suiteSchema.parse({ ...base, baseURL: app.url, journeys: [broken] }),
      chooser,
      { directory: await output('broken') },
    );
    assert.equal(results[0]?.status, 'failed');
    assert.match(results[0]?.reason ?? '', /Repeated/);
    assert.ok(
      results[0]?.findings.some((finding) => finding.category === 'loop'),
    );
  } finally {
    await app.close();
  }
});

test('an expired or missing login never becomes a task pass', async () => {
  const app = await fixture();
  try {
    await assert.rejects(
      runSuite(
        suiteSchema.parse({ ...base, baseURL: app.url, requiresAuth: true }),
        deterministic,
        { directory: await output('missing-auth') },
      ),
      /storage-state/,
    );
  } finally {
    await app.close();
  }
});

test('repeated no_match recovers by scrolling to an off-screen destination at narrow width', async () => {
  const app = await fixture();
  const directory = await output('scroll-recovery');
  let planCalls = 0;
  try {
    const results = await runSuite(
      suiteSchema.parse({
        ...base,
        baseURL: app.url,
        viewports: [{ name: 'narrow', width: 390, height: 844 }],
        journeys: [
          {
            ...journey,
            startPath: '/scroll',
            allowedPaths: ['/scroll', '/sessions'],
          },
        ],
      }),
      {
        ...deterministic,
        async plan() {
          planCalls++;
          return {
            objective: 'Find and open the session below the summaries',
            concerns: [],
          };
        },
      },
      { directory },
    );
    assert.equal(results[0]?.status, 'passed');
    assert.deepEqual(results[0]?.checks, [true, true]);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const recovery = events.filter((event) => event.event === 'recovery');
    assert.ok(recovery.length >= 1 && recovery.length <= 2);
    assert.ok(planCalls >= 2, 'Reconsider the plan before recovery');
    assert.ok(
      recovery.every(
        (event) =>
          event.data.action.kind === 'scroll' &&
          event.data.action.direction === 'down',
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.event === 'action_result' && event.data.source === 'recovery',
      ),
    );
    assert.ok(
      results[0]?.findings.some(
        (finding) => finding.category === 'selector-recovery',
      ),
    );
  } finally {
    await app.close();
  }
});

test('no_match recovery stops when a scrollable page blocks the wheel and never clicks an offered control', async () => {
  const app = await fixture();
  const directory = await output('no-progress-recovery');
  let choices = 0;
  try {
    const results = await runSuite(
      suiteSchema.parse({
        ...base,
        baseURL: app.url,
        journeys: [
          {
            ...journey,
            startPath: '/blocked-scroll',
            allowedPaths: ['/blocked-scroll', '/sessions'],
          },
        ],
      }),
      {
        ...deterministic,
        async choose(_j, _o, _p, actions) {
          choices++;
          assert.ok(actions.some((action) => action.kind === 'link'));
          return selected('no_match', actions);
        },
      },
      { directory },
    );
    assert.equal(results[0]?.status, 'failed');
    assert.match(results[0]?.reason ?? '', /did not advance the viewport/);
    assert.equal(choices, 2);
    assert.ok(!app.requests.some((request) => request.path === '/sessions'));
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      events.filter((event) => event.event === 'recovery').length,
      1,
    );
  } finally {
    await app.close();
  }
});

test('no_match recovery remains capped even when each scroll makes progress', async () => {
  const app = await fixture();
  const directory = await output('capped-recovery');
  let choices = 0;
  try {
    const results = await runSuite(
      suiteSchema.parse({
        ...base,
        baseURL: app.url,
        journeys: [
          {
            ...journey,
            startPath: '/long-scroll',
            allowedPaths: ['/long-scroll', '/sessions'],
            maxSteps: 20,
          },
        ],
      }),
      {
        ...deterministic,
        async choose(_j, _o, _p, actions) {
          choices++;
          return selected('no_match', actions);
        },
      },
      { directory },
    );
    assert.equal(results[0]?.status, 'failed');
    assert.match(results[0]?.reason ?? '', /after bounded scroll recovery/);
    assert.equal(choices, 6);
    assert.equal(results[0]?.steps, 2);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      events.filter((event) => event.event === 'recovery').length,
      2,
    );
    assert.ok(
      !app.requests.some((request) => request.path === '/sessions/example'),
    );
  } finally {
    await app.close();
  }
});

test('browser refuses a selected link after its destination changes', async () => {
  const app = await fixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(app.url);
    const directory = await mkdtemp(join(tmpdir(), 'ui-ux-stale-'));
    const before = await observe(page, 0, join(directory, 'before.png'));
    const offered = await candidates(page, journey, app.url);
    await page.evaluate(() => {
      document.querySelector('a')!.setAttribute('href', '/sessions/example');
    });
    await assert.rejects(
      execute(
        page,
        offered.find((action) => action.kind === 'link')!,
        before,
        journey,
        app.url,
      ),
      /Stale observation/,
    );
    assert.equal(new URL(page.url()).pathname, '/');
  } finally {
    await browser?.close();
    await app.close();
  }
});

test('off-screen actions require scrolling and nested scroll progress changes the observation', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.setContent(
      '<div id="scroller" style="height:300px;overflow:auto"><div style="height:1200px"></div><a href="http://127.0.0.1:1/sessions">Sessions</a></div>',
    );
    const directory = await mkdtemp(join(tmpdir(), 'ui-ux-scroll-'));
    const before = await observe(page, 0, join(directory, 'before.png'));
    assert.ok(
      !(await candidates(page, journey, base.baseURL)).some(
        (action) => action.kind === 'link',
      ),
    );
    await page.locator('#scroller').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await observe(page, 1, join(directory, 'after.png'));
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.ok(
      (await candidates(page, journey, base.baseURL)).some(
        (action) => action.kind === 'link',
      ),
    );
  } finally {
    await browser.close();
  }
});

test('untrusted model findings cannot inject executable HTML into reports', () => {
  const html = reportHTML('<script>alert(1)</script>', [], '/tmp');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('starter suites are public, generic and escape destination regex characters', () => {
  const suite = starterSuite('https://shop.example', '/plans.v2');
  assert.equal(suite.requiresAuth, false);
  assert.equal(suite.browser, 'chromium');
  const success = suite.journeys[0]!.success[0]!;
  assert.equal(success.kind, 'path');
  if (success.kind === 'path') {
    assert.ok(new RegExp(success.pattern).test('/plans.v2'));
    assert.ok(!new RegExp(success.pattern).test('/plansXv2'));
  }
  assert.throws(() => starterSuite('file:///tmp/app.html', '/plans'));
});

test('additional navigation origins and writes must be explicitly scoped', () => {
  assert.equal(
    allowedURL('https://docs.example/docs/install', base.baseURL, ['/docs']),
    false,
  );
  assert.equal(
    allowedURL(
      'https://docs.example/docs/install',
      base.baseURL,
      ['/docs'],
      ['https://docs.example'],
    ),
    true,
  );
  const suite = suiteSchema.parse({
    ...base,
    allowedRequests: [
      { method: 'PUT', origin: 'https://api.example', path: '/test-profile' },
    ],
  });
  assert.equal(
    allowedRequest(
      { method: () => 'PUT', url: () => 'https://api.example/test-profile' },
      suite,
    ),
    true,
  );
  assert.equal(
    allowedRequest(
      { method: () => 'DELETE', url: () => 'https://api.example/test-profile' },
      suite,
    ),
    false,
  );
  assert.throws(() =>
    suiteSchema.parse({
      ...base,
      allowedOrigins: ['https://docs.example/private'],
    }),
  );
});

test('configured form actions work on a website without application test IDs', async () => {
  const app = await fixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(app.url);
    await page.setContent(
      '<main><label>Email<input placeholder="Your email"></label><label for="plan">Plan</label><select id="plan"><option value="monthly">Monthly</option><option value="annual">Annual</option></select><label>Updates<input type="checkbox"></label><button type="button" onclick="document.querySelector(\'.confirmation\').textContent = document.querySelector(\'input\').value + \': \' + document.querySelector(\'select\').value + \': \' + document.querySelector(\'input[type=checkbox]\').checked">Preview choice</button><output class="confirmation"></output></main>',
    );
    const configured = suiteSchema.parse({
      ...base,
      baseURL: app.url,
      journeys: [
        {
          ...journey,
          discoverRoles: ['button'],
          interactions: [
            {
              kind: 'fill',
              target: { by: 'placeholder', value: 'Your email' },
              value: 'visitor@example.test',
              description: 'Enter the test email',
            },
            {
              kind: 'select',
              target: { by: 'label', value: 'Plan' },
              value: 'annual',
              description: 'Select annual plan',
            },
            {
              kind: 'check',
              target: { by: 'label', value: 'Updates' },
              checked: true,
              description: 'Opt into updates in the local fixture',
            },
          ],
        },
      ],
    }).journeys[0]!;
    const directory = await mkdtemp(join(tmpdir(), 'ui-ux-form-'));
    for (const kind of ['fill', 'select', 'check', 'click']) {
      const offered = await candidates(page, configured, app.url);
      const action = offered.find((action) => action.kind === kind)!;
      assert.ok(action, `Expected offered ${kind}`);
      await execute(
        page,
        action,
        await observe(page, 0, join(directory, 'state.png')),
        configured,
        app.url,
      );
    }
    assert.equal(
      await page.locator('.confirmation').innerText(),
      'visitor@example.test: annual: true',
    );
  } finally {
    await browser?.close();
    await app.close();
  }
});

test('structured-output schemas drop value keywords but keep fields that share their names', () => {
  assert.deepEqual(
    portableSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, pattern: '^a' },
        items: { type: 'array', maxItems: 6, items: { type: 'string' } },
      },
      required: ['pattern', 'items'],
      additionalProperties: false,
    }),
    {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['pattern', 'items'],
      additionalProperties: false,
    },
  );
});

test('a planner completion truncated at the token limit is rejected, not parsed', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: { content: '{"objective": "Open the' },
            finish_reason: 'length',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-truncated-'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Fixture</h1>');
    const observation = await observe(page, 0, join(directory, 'step.png'));
    const planner = models({
      plannerURL: `http://127.0.0.1:${address.port}/planner`,
      plannerKey: 'test-only',
      plannerModel: 'fixture',
      selectorURL: '',
      selectorKey: '',
      selectorModel: '',
    });
    await assert.rejects(
      planner.plan(journey, observation, [], 5000),
      /truncated at the token limit/,
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the planner sees which visible controls are offered only when the driver reports them', async () => {
  const bodies: {
    observation: {
      visibleViewport: { controls: { name: string; offered?: boolean }[] };
    };
    constraint?: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    const payload = (await body(request)) as {
      messages: { content: { type: string; text?: string }[] | string }[];
    };
    const content = payload.messages[1]!.content as {
      type: string;
      text?: string;
    }[];
    bodies.push(
      JSON.parse(content.find((part) => part.type === 'text')!.text!),
    );
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"objective": "Open Sessions", "concerns": []}',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-offered-'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<a href="/sessions">Sessions</a> <a href="/elsewhere">Work Units</a>',
    );
    const observation = await observe(page, 0, join(directory, 'step.png'));
    const planner = models({
      plannerURL: `http://127.0.0.1:${address.port}/planner`,
      plannerKey: 'test-only',
      plannerModel: 'fixture',
      selectorURL: '',
      selectorKey: '',
      selectorModel: '',
    });
    await planner.plan(journey, observation, [], 5000, [], {
      reasons: ['initial'],
      offeredControls: ['Sessions'],
    });
    await planner.plan(journey, observation, [], 5000, [], {
      reasons: ['initial'],
    });
    assert.deepEqual(
      bodies[0]!.observation.visibleViewport.controls.map((control) => [
        control.name,
        control.offered,
      ]),
      [
        ['Sessions', true],
        ['Work Units', false],
      ],
    );
    assert.match(bodies[0]!.constraint!, /offered: false cannot be used/);
    assert.ok(
      bodies[1]!.observation.visibleViewport.controls.every(
        (control) => !('offered' in control),
      ),
    );
    assert.equal(bodies[1]!.constraint, undefined);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('structured output wrapped in one key is unwrapped only when the inner object is valid', () => {
  const plan = { objective: 'Open Sessions', concerns: [] };
  assert.deepEqual(
    parseStructured(JSON.stringify({ json_schema: plan }), planSchema),
    plan,
  );
  assert.deepEqual(parseStructured(JSON.stringify(plan), planSchema), plan);
  assert.throws(
    () =>
      parseStructured(JSON.stringify({ plan: { objective: '' } }), planSchema),
    /objective/,
  );
  assert.throws(
    () => parseStructured(JSON.stringify({ a: plan, b: plan }), planSchema),
    /objective/,
  );
});

test('an invalid structured planner reply is retried once; truncation is not', async () => {
  const replies: { content: string; finish_reason: string }[][] = [];
  let requests = 0;
  const server = createServer((_request, response) => {
    const reply = replies[0]![requests++] ?? replies[0]!.at(-1)!;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: { content: reply.content },
            finish_reason: reply.finish_reason,
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-retry-'));
  const browser = await chromium.launch();
  const valid = {
    content: '{"objective": "Open Sessions", "concerns": []}',
    finish_reason: 'stop',
  };
  const decorated = {
    content:
      '{"$FUNCTION_NAME": "\\n", "objective": "Open Sessions", "concerns": []}',
    finish_reason: 'stop',
  };
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Fixture</h1>');
    const observation = await observe(page, 0, join(directory, 'step.png'));
    const attempts: (number | undefined)[] = [];
    const planner = models({
      plannerURL: `http://127.0.0.1:${address.port}/planner`,
      plannerKey: 'test-only',
      plannerModel: 'fixture',
      selectorURL: '',
      selectorKey: '',
      selectorModel: '',
      onCall: async (data) => {
        attempts.push(data.attempt);
      },
    });
    const run = async (sequence: (typeof valid)[]) => {
      replies[0] = sequence;
      requests = 0;
      attempts.length = 0;
      return planner
        .plan(journey, observation, [], 5000)
        .catch((error: Error) => error);
    };
    const recovered = await run([decorated, valid]);
    assert.deepEqual(recovered, { objective: 'Open Sessions', concerns: [] });
    assert.deepEqual(attempts, [1, 2]);
    const failed = await run([decorated, decorated]);
    assert.ok(
      failed instanceof Error && /\$FUNCTION_NAME/.test(failed.message),
    );
    assert.equal(requests, 2);
    const truncated = await run([
      { content: '{"objective": "Op', finish_reason: 'length' },
    ]);
    assert.ok(
      truncated instanceof Error && /truncated/.test(truncated.message),
    );
    assert.equal(requests, 1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
