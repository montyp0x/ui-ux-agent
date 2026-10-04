import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { observe } from '../src/browser.js';
import { modelOptionsFromEnv } from '../src/config.js';
import type { Action } from '../src/contracts.js';
import { models } from '../src/models.js';
import { starterSuite } from '../src/scaffold.js';

test('the default selector is TypeSafe Jev and requires its key', () => {
  const options = modelOptionsFromEnv({
    PLANNER_API_KEY: 'p',
    JEV_API_KEY: 'j',
  });
  assert.equal(options.selectorProtocol, 'typesafe');
  assert.equal(options.selectorURL, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(options.selectorKey, 'j');
  assert.throws(
    () => modelOptionsFromEnv({ PLANNER_API_KEY: 'p' }),
    /JEV_API_KEY \(or set SELECTOR_PROTOCOL=chat/,
  );
  assert.throws(
    () => modelOptionsFromEnv({ JEV_API_KEY: 'j' }),
    /PLANNER_API_KEY/,
  );
});

test('SELECTOR_PROTOCOL=chat needs one provider: the selector reuses the planner settings', () => {
  const env = {
    PLANNER_API_URL: 'https://llm.example/v1/chat/completions',
    PLANNER_API_KEY: 'p',
    PLANNER_MODEL: 'big',
    PLANNER_API_HEADERS: '{"X-Gateway":"g"}',
    SELECTOR_PROTOCOL: 'chat',
  };
  const options = modelOptionsFromEnv(env);
  assert.deepEqual(
    [
      options.selectorURL,
      options.selectorKey,
      options.selectorModel,
      options.selectorHeaders,
    ],
    [
      'https://llm.example/v1/chat/completions',
      'p',
      'big',
      { 'X-Gateway': 'g' },
    ],
  );
  const small = modelOptionsFromEnv({ ...env, SELECTOR_MODEL: 'small' });
  assert.equal(small.selectorModel, 'small');
  assert.throws(
    () => modelOptionsFromEnv({ ...env, PLANNER_API_HEADERS: '["x"]' }),
    /PLANNER_API_HEADERS must be a JSON object/,
  );
  assert.throws(() =>
    modelOptionsFromEnv({ ...env, SELECTOR_PROTOCOL: 'other' }),
  );
});

async function body(request: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of request) data += String(chunk);
  return JSON.parse(data);
}

const actions: Action[] = [
  {
    kind: 'link',
    id: 'a0',
    description: 'Open Sessions',
    target: { by: 'role', role: 'link', name: 'Sessions' },
    href: 'https://app.example/sessions',
  },
  { kind: 'wait', id: 'a1', description: 'Wait briefly for loading to finish' },
];

async function chatSelector(reply: unknown) {
  const requests: { body: unknown; gateway: unknown }[] = [];
  const server = createServer(async (request, response) => {
    requests.push({
      body: await body(request),
      gateway: request.headers['x-gateway'],
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<a href="/sessions">Sessions</a>');
    const directory = await mkdtemp(join(tmpdir(), 'ui-ux-chat-'));
    const observation = await observe(page, 0, join(directory, 'step.png'));
    const selector = models(
      modelOptionsFromEnv({
        PLANNER_API_URL: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        PLANNER_API_KEY: 'test-only',
        PLANNER_API_HEADERS: '{"X-Gateway":"g"}',
        SELECTOR_PROTOCOL: 'chat',
      }),
    );
    const journey = starterSuite('https://app.example', '/sessions')
      .journeys[0]!;
    const result = selector.choose(
      journey,
      observation,
      { objective: 'Open Sessions', concerns: [] },
      actions,
      [],
      5000,
    );
    return { result: await result.catch((error: Error) => error), requests };
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const reply = (content: unknown, finish_reason = 'stop') => ({
  choices: [{ message: { content: JSON.stringify(content) }, finish_reason }],
});

test('the chat selector constrains output to the offered ids and normalizes its distribution', async () => {
  const { result, requests } = await chatSelector(
    reply({ choice: 'a0', probabilities: { a0: 0.8, a1: 0.1, no_match: 0.3 } }),
  );
  assert.ok(!(result instanceof Error), String(result));
  assert.equal(result.choice, 'a0');
  assert.ok(
    Math.abs(
      Object.values(result.probabilities).reduce((a, b) => a + b, 0) - 1,
    ) < 1e-9,
  );
  assert.equal(result.confidence, result.probabilities.a0);
  const sent = requests[0]!.body as {
    max_completion_tokens: number;
    response_format: {
      json_schema: {
        schema: {
          properties: {
            choice: { enum: string[] };
            probabilities: { required: string[] };
          };
        };
      };
    };
  };
  assert.equal(requests[0]!.gateway, 'g');
  assert.equal(sent.max_completion_tokens, 400);
  const schema = sent.response_format.json_schema.schema.properties;
  assert.deepEqual(schema.choice.enum, ['a0', 'a1', 'no_match']);
  assert.deepEqual(schema.probabilities.required, ['a0', 'a1', 'no_match']);
});

test('the chat selector rejects unknown choices, missing options and truncation', async () => {
  for (const [content, finish, pattern] of [
    [
      { choice: 'a9', probabilities: { a0: 0.5, a1: 0.5, no_match: 0 } },
      'stop',
      /unknown or incomplete/,
    ],
    [
      { choice: 'a0', probabilities: { a0: 1 } },
      'stop',
      /unknown or incomplete/,
    ],
    [
      { choice: 'a0', probabilities: { a0: 0, a1: 0, no_match: 0 } },
      'stop',
      /empty probability distribution/,
    ],
    [{ choice: 'a0', probabilities: {} }, 'length', /truncated/],
  ] as const) {
    const { result } = await chatSelector(reply(content, finish));
    assert.ok(result instanceof Error);
    assert.match(result.message, pattern);
  }
});
