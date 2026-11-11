import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
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

// Controlled time: setTimeout and Date are mocked, so these tests do not
// depend on wall-clock scheduling. setImmediate stays real and flushes the
// promise continuations a fired timer schedules.
function fakeTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    flush,
    async advance(ms: number, step = 10) {
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        t.mock.timers.tick(step);
        await flush();
      }
    },
  };
}

test('a queued request rechecks a cooldown applied while it waits', async (t) => {
  const time = fakeTime(t);
  const limiter = new EndpointLimiter({ rpm: 600, concurrency: 2 });
  await limiter.acquire(5000);
  let startedAt: number | null = null;
  const queued = limiter.acquire(5000).then(() => (startedAt = Date.now()));
  await time.flush();
  // The queued request was scheduled for 100ms; a 429 now pauses the endpoint.
  limiter.throttled(1000);
  await time.advance(1500);
  await queued;
  assert.ok(startedAt !== null && startedAt >= 1000, `started at ${startedAt}`);
});

test('a request waiting for a slot is woken after an earlier waiter timed out', async (t) => {
  const time = fakeTime(t);
  const limiter = new EndpointLimiter({ rpm: 6000, concurrency: 1 });
  await limiter.acquire(5000);
  const expired = assert.rejects(limiter.acquire(100), RateLimitBudgetError);
  let startedAt: number | null = null;
  const later = limiter.acquire(5000).then(() => (startedAt = Date.now()));
  await time.advance(200);
  await expired;
  limiter.release();
  await time.advance(50);
  assert.ok(startedAt !== null && startedAt <= 250, `started at ${startedAt}`);
  await later;
});

test('overlapping cooldowns keep the latest expiry', async (t) => {
  const time = fakeTime(t);
  const limiter = new EndpointLimiter({ rpm: 6000, concurrency: 2 });
  limiter.throttled(1000);
  // A shorter cooldown does not shorten the current one.
  limiter.throttled(300);
  let startedAt: number | null = null;
  const queued = limiter.acquire(10000).then(() => (startedAt = Date.now()));
  await time.advance(800);
  assert.equal(startedAt, null);
  // A cooldown that ends later extends it while the request waits.
  limiter.throttled(500);
  await time.advance(1000);
  await queued;
  assert.ok(startedAt !== null && startedAt >= 1300, `started at ${startedAt}`);
  limiter.release();
});

test('requests released by a cooldown are still spaced by the rate', async (t) => {
  const time = fakeTime(t);
  const limiter = new EndpointLimiter({ rpm: 600, concurrency: 3 });
  limiter.throttled(1000); // also halves the rate: one start per 200ms
  const starts: number[] = [];
  const queued = [1, 2].map(() =>
    limiter.acquire(10000).then(() => starts.push(Date.now())),
  );
  await time.advance(1500);
  await Promise.all(queued);
  assert.ok(starts[0]! >= 1000, `first at ${starts[0]}`);
  assert.ok(
    starts[1]! - starts[0]! >= 200,
    `spaced ${starts[1]! - starts[0]!}ms`,
  );
});

test('a cooldown that passes the deadline fails a waiting request at once and frees its slot', async (t) => {
  const time = fakeTime(t);
  const limiter = new EndpointLimiter({ rpm: 60, concurrency: 2 });
  await limiter.acquire(5000);
  let outcome: unknown = null;
  // Scheduled for 1000ms, inside its 3000ms deadline.
  const queued = limiter.acquire(3000).catch((caught) => (outcome = caught));
  await time.flush();
  assert.equal(limiter.inFlight, 2);
  limiter.throttled(10000);
  await time.flush();
  assert.ok(outcome instanceof RateLimitBudgetError);
  assert.equal(Date.now(), 0, 'did not sleep before failing');
  assert.equal(limiter.inFlight, 1);
  await queued;
});

test('an aborted request never starts and gives back its slot', async (t) => {
  const time = fakeTime(t);
  const limiter = new EndpointLimiter({ rpm: 6000, concurrency: 1 });
  // Already aborted: rejected without taking a slot.
  await assert.rejects(
    limiter.acquire(5000, AbortSignal.abort()),
    (caught: Error) => caught.name === 'AbortError',
  );
  assert.equal(limiter.inFlight, 0);

  // Aborted while waiting for a slot.
  await limiter.acquire(5000);
  const slot = new AbortController();
  const forSlot = assert.rejects(
    limiter.acquire(5000, slot.signal),
    (caught: Error) => caught.name === 'AbortError',
  );
  await time.flush();
  slot.abort();
  await forSlot;
  let nextStarted = false;
  const next = limiter.acquire(5000).then(() => (nextStarted = true));
  limiter.release();
  await time.advance(50);
  assert.equal(nextStarted, true, 'the slot went to the next live waiter');
  await next;
  limiter.release();
  assert.equal(limiter.inFlight, 0);

  // Aborted while holding a slot and waiting for its start.
  limiter.throttled(1000);
  const pacing = new AbortController();
  const forStart = assert.rejects(
    limiter.acquire(5000, pacing.signal),
    (caught: Error) => caught.name === 'AbortError',
  );
  await time.advance(100);
  assert.equal(limiter.inFlight, 1);
  pacing.abort();
  await forStart;
  assert.equal(limiter.inFlight, 0);
});

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
