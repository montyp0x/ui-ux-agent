// Data lifecycle for authorized write flows: reset, setup and cleanup hooks
// on an isolated LOCAL fixture service, called by the runner around each run.
//
// - reset: once, before the suite's first run (clears what a crashed earlier
//   run may have left);
// - setup: before each run, with the run's marker; it may return disposable
//   values (a test identity) that the journey reads as {{data.<key>}};
// - cleanup: after each run, whatever ended it (pass, failure, timeout,
//   cancellation or an error), after the browser session has closed;
// - verify: optionally, after cleanup, how many records of the run remain.
//
// A hook that fails, times out, returns invalid output or leaves records is a
// cleanup failure: recorded on the result, as an observed finding, and at the
// top of the report. Hooks only reach the configured loopback service, never
// follow redirects, and values are never written to results or logs (only
// their keys).
import { z } from 'zod';
import type { EventLogger } from './drivers/types.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const relativePath = z
  .string()
  .regex(/^\/(?!\/)/)
  .refine((value) => !value.includes('\\'));

export const loopbackOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    LOOPBACK.has(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  );
}, 'dataLifecycle.service must be a local fixture service: an http(s) origin on 127.0.0.1, localhost or [::1], without credentials, path, query or fragment');

const hook = <M extends [string, ...string[]]>(methods: M) =>
  z
    .object({ method: z.enum(methods), path: relativePath })
    .strict();

export const dataLifecycleSchema = z
  .object({
    service: loopbackOriginSchema,
    reset: hook(['POST', 'DELETE']).optional(),
    setup: hook(['POST', 'PUT']).optional(),
    cleanup: hook(['POST', 'DELETE']),
    // GET; answers {"remaining": <records of the run still stored>}.
    verify: z.object({ path: relativePath }).strict().optional(),
    // Bound on each hook call.
    timeoutMs: z.number().int().min(1000).max(60000).default(10000),
  })
  .strict();
export type DataLifecycle = z.infer<typeof dataLifecycleSchema>;

// What setup may answer. Values replace {{data.<key>}} in the journey.
const DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const setupResponseSchema = z
  .object({
    values: z
      .record(z.string().regex(DATA_KEY), z.string().max(500))
      .refine((values) => Object.keys(values).length <= 20, 'At most 20 values')
      .default({}),
  })
  .strict();
const verifyResponseSchema = z
  .object({ remaining: z.number().int().nonnegative() })
  .strict();

export const DATA_PLACEHOLDER = /\{\{data\.([A-Za-z][A-Za-z0-9_]{0,39})\}\}/g;

// What ended the run, as sent to cleanup.
export const cleanupTriggerSchema = z.enum([
  'passed',
  'failed',
  'blocked',
  'timeout',
  'cancelled',
  'error',
]);
export type CleanupTrigger = z.infer<typeof cleanupTriggerSchema>;

const hookRecordSchema = z
  .object({
    status: z.enum(['ok', 'failed']),
    durationMs: z.number().nonnegative(),
    // Why it failed (status, timeout, invalid output), or null.
    detail: z.string().nullable(),
  })
  .strict();
export type HookRecord = z.infer<typeof hookRecordSchema>;

export const dataLifecycleResultSchema = z
  .object({
    service: z.string(),
    // The run's marker, sent to every hook as "run".
    run: z.string(),
    reset: hookRecordSchema.nullable(),
    setup: hookRecordSchema.nullable(),
    // Keys of the values setup returned (the values are never recorded).
    values: z.array(z.string()),
    cleanup: hookRecordSchema
      .extend({
        trigger: cleanupTriggerSchema,
        // Records verify reported after cleanup; null without verify.
        remaining: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    // False when cleanup failed, could not be verified, or never ran.
    clean: z.boolean(),
  })
  .strict();
export type DataLifecycleResult = z.infer<typeof dataLifecycleResultSchema>;

function firstLine(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.split('\n')[0]!.slice(0, 200);
}

async function call(
  config: DataLifecycle,
  method: string,
  path: string,
  body: Record<string, string> | null,
): Promise<unknown> {
  const url = new URL(path, config.service);
  const response = await fetch(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(config.timeoutMs),
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${url.pathname} answered HTTP ${response.status}`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${url.pathname} answered invalid JSON`);
  }
}

async function timed<T>(
  work: () => Promise<T>,
): Promise<{ record: HookRecord; value: T | null }> {
  const started = Date.now();
  try {
    const value = await work();
    return {
      record: { status: 'ok', durationMs: Date.now() - started, detail: null },
      value,
    };
  } catch (caught) {
    return {
      record: {
        status: 'failed',
        durationMs: Date.now() - started,
        detail:
          (caught as { name?: string } | null)?.name === 'TimeoutError'
            ? 'timed out'
            : firstLine(caught),
      },
      value: null,
    };
  }
}

// One run's lifecycle: setup before the session, cleanup exactly once after.
export class LifecycleRun {
  readonly record: DataLifecycleResult;
  values: Record<string, string> = {};
  private cleaned: Promise<void> | null = null;

  constructor(
    private readonly config: DataLifecycle,
    run: string,
    reset: HookRecord | null,
    private readonly log: EventLogger,
    private readonly context: { journey: string; viewport: string },
  ) {
    this.record = {
      service: config.service,
      run,
      reset,
      setup: null,
      values: [],
      cleanup: null,
      clean: false,
    };
  }

  // Why the run cannot start (failed reset or setup), or null.
  get setupFailure(): string | null {
    if (this.record.reset?.status === 'failed')
      return `Data reset failed: ${this.record.reset.detail}`;
    if (this.record.setup?.status === 'failed')
      return `Data setup failed: ${this.record.setup.detail}`;
    return null;
  }

  async setup(): Promise<void> {
    if (!this.config.setup || this.record.reset?.status === 'failed') return;
    const { method, path } = this.config.setup;
    const { record, value } = await timed(async () =>
      setupResponseSchema.parse(
        (await call(this.config, method, path, { run: this.record.run })) ?? {},
      ),
    );
    this.record.setup = record;
    if (value) {
      this.values = value.values;
      this.record.values = Object.keys(value.values);
    }
    await this.log('data_setup', {
      ...this.context,
      run: this.record.run,
      ...record,
      values: this.record.values,
    });
  }

  // Marks setup failed when the journey still references a value setup did
  // not return.
  missingValue(key: string): void {
    this.record.setup = {
      status: 'failed',
      durationMs: this.record.setup?.durationMs ?? 0,
      detail: `the journey uses {{data.${key}}} but setup returned no ${key}`,
    };
  }

  cleanup(trigger: CleanupTrigger): Promise<void> {
    this.cleaned ??= this.runCleanup(trigger);
    return this.cleaned;
  }

  private async runCleanup(trigger: CleanupTrigger): Promise<void> {
    const { method, path } = this.config.cleanup;
    const run = this.record.run;
    const { record } = await timed(() =>
      call(this.config, method, path, { run, trigger }),
    );
    let remaining: number | null = null;
    let outcome = record;
    if (record.status === 'ok' && this.config.verify) {
      const verify = this.config.verify;
      const checked = await timed(async () => {
        const url = new URL(verify.path, this.config.service);
        url.searchParams.set('run', run);
        return verifyResponseSchema.parse(
          await call(this.config, 'GET', `${url.pathname}${url.search}`, null),
        );
      });
      remaining = checked.value?.remaining ?? null;
      outcome = {
        status:
          checked.record.status === 'ok' && remaining === 0 ? 'ok' : 'failed',
        durationMs: record.durationMs + checked.record.durationMs,
        detail:
          checked.record.status === 'failed'
            ? `verify failed: ${checked.record.detail}`
            : remaining
              ? `${remaining} record(s) of the run remain after cleanup`
              : null,
      };
    }
    this.record.cleanup = { ...outcome, trigger, remaining };
    this.record.clean = outcome.status === 'ok';
    await this.log('data_cleanup', {
      ...this.context,
      run,
      trigger,
      ...outcome,
      remaining,
    });
  }
}

// The suite-wide lifecycle: reset once, then a LifecycleRun per run.
export class DataLifecycleHooks {
  private reset: Promise<HookRecord | null> | null = null;

  constructor(
    private readonly config: DataLifecycle,
    private readonly log: EventLogger,
  ) {}

  private resetOnce(): Promise<HookRecord | null> {
    const reset = this.config.reset;
    this.reset ??= reset
      ? timed(() => call(this.config, reset.method, reset.path, {})).then(
          async ({ record }) => {
            await this.log('data_reset', { service: this.config.service, ...record });
            return record;
          },
        )
      : Promise.resolve(null);
    return this.reset;
  }

  async begin(
    run: string,
    context: { journey: string; viewport: string },
  ): Promise<LifecycleRun> {
    const lifecycle = new LifecycleRun(
      this.config,
      run,
      await this.resetOnce(),
      this.log,
      context,
    );
    await lifecycle.setup();
    return lifecycle;
  }
}

// Replaces {{data.<key>}} in the journey with setup's values (JSON-escaped);
// returns the first key that has no value, if any.
export function withData<T>(
  journey: T,
  values: Record<string, string>,
): { journey: T; missing: string | null } {
  const text = JSON.stringify(journey);
  if (!text.includes('{{data.')) return { journey, missing: null };
  let missing: string | null = null;
  const replaced = text.replace(DATA_PLACEHOLDER, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing ??= key;
      return placeholder;
    }
    return JSON.stringify(value).slice(1, -1);
  });
  return { journey: JSON.parse(replaced) as T, missing };
}
