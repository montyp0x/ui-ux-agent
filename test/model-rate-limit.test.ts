import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { modelOptionsFromEnv } from '../src/config.js';
import {
  EndpointLimiter,
  post,
  RateLimitBudgetError,
  retryAfterMs,
  type ModelWait,
} from '../src/models.js';

async function server(
  respond: (count: number) => {
    status: number;
    headers?: Record<string, string>;
  },
) {
  let count = 0;
  const starts: number[] = [];
  const http = createServer((_request, response) => {
    starts.push(Date.now());
    const { status, headers = {} } = respond(++count);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      ...headers,
    });
    response.end(JSON.stringify({ ok: status === 200 }));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat`,
    starts,
    count: () => count,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

test('requests to one endpoint are spaced by its requests-per-minute limit', async () => {
  const limiter = new EndpointLimiter({ rpm: 600, concurrency: 1 });
  const started = Date.now();
  for (let i = 0; i < 3; i++) {
    await limiter.acquire(Date.now() + 5000);
    limiter.release();
  }
  // 600 rpm = one start per 100ms: the third starts about 200ms after the first.
  assert.ok(Date.now() - started >= 190, `${Date.now() - started}ms`);
});

test('a wait that would pass the step budget fails at once instead of sleeping', async () => {
  const limiter = new EndpointLimiter({ rpm: 1, concurrency: 1 });
  await limiter.acquire(Date.now() + 1000);
  limiter.release();
  const started = Date.now();
  await assert.rejects(
    limiter.acquire(Date.now() + 1000),
    RateLimitBudgetError,
  );
  assert.ok(Date.now() - started < 100);
});

test('concurrency is capped per endpoint', async () => {
  const limiter = new EndpointLimiter({ rpm: 6000, concurrency: 1 });
  await limiter.acquire(Date.now() + 5000);
  let second = false;
  const pending = limiter
    .acquire(Date.now() + 5000)
    .then(() => (second = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second, false);
  limiter.release();
  await pending;
  assert.equal(second, true);
  limiter.release();
});

test('a 429 is retried after Retry-After, logged, and slows the endpoint', async () => {
  const api = await server((n) =>
    n === 1
      ? { status: 429, headers: { 'Retry-After': '1' } }
      : { status: 200 },
  );
  const limiter = new EndpointLimiter({ rpm: 60, concurrency: 1 });
  const waits: ModelWait[] = [];
  try {
    const payload = await post(
      api.url,
      'key',
      {},
      10000,
      {},
      {
        role: 'planner',
        limiter,
        onWait: async (data) => {
          waits.push(data);
        },
      },
    );
    assert.deepEqual(payload, { ok: true });
    assert.equal(api.count(), 2);
    assert.ok(api.starts[1]! - api.starts[0]! >= 950, 'waited for Retry-After');
    const limited = waits.find((wait) => wait.reason === 'rate_limited');
    assert.ok(limited);
    assert.equal(limited.status, 429);
    assert.equal(limited.waitMs, 1000);
    // Halved on the 429, then +1 on the success.
    assert.equal(limiter.rpm, 31);
  } finally {
    await api.close();
  }
});

test('repeated 429s give up within the step budget with a clear error', async () => {
  const api = await server(() => ({
    status: 429,
    headers: { 'Retry-After': '1' },
  }));
  const limiter = new EndpointLimiter({ rpm: 600, concurrency: 1 });
  const started = Date.now();
  try {
    await assert.rejects(
      post(api.url, 'key', {}, 2500, {}, { role: 'selector', limiter }),
      /Model HTTP 429 after \d attempts \(rate limited\)|past the step budget/,
    );
    assert.ok(Date.now() - started < 3500);
  } finally {
    await api.close();
  }
});

test('other HTTP errors are not retried', async () => {
  const api = await server(() => ({ status: 400 }));
  try {
    await assert.rejects(
      post(
        api.url,
        'key',
        {},
        5000,
        {},
        {
          role: 'planner',
          limiter: new EndpointLimiter({ rpm: 600, concurrency: 1 }),
        },
      ),
      /Model HTTP 400/,
    );
    assert.equal(api.count(), 1);
  } finally {
    await api.close();
  }
});

test('Retry-After accepts seconds or an HTTP date and is capped', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterMs('2', now), 2000);
  assert.equal(retryAfterMs(new Date(now + 5000).toUTCString(), now), 5000);
  assert.equal(retryAfterMs('3600', now), 60000);
  assert.equal(retryAfterMs('soon', now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test('rate limits come from the environment and are validated', () => {
  const base = { PLANNER_API_KEY: 'k', JEV_API_KEY: 'j' };
  assert.equal(modelOptionsFromEnv(base).plannerRateLimit, undefined);
  assert.deepEqual(
    modelOptionsFromEnv({ ...base, PLANNER_MAX_RPM: '6' }).plannerRateLimit,
    { rpm: 6, concurrency: 2 },
  );
  assert.deepEqual(
    modelOptionsFromEnv({ ...base, SELECTOR_MAX_CONCURRENCY: '2' })
      .selectorRateLimit,
    { rpm: 300, concurrency: 2 },
  );
  assert.throws(
    () => modelOptionsFromEnv({ ...base, PLANNER_MAX_RPM: 'fast' }),
    /PLANNER_MAX_RPM must be an integer/,
  );
});
