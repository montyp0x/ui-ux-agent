// The benchmark's ceilings, enforced while it runs. The budget sees every
// model request right before it is sent (ModelOptions.beforeDispatch) and
// every response (ModelOptions.onCall). Once a ceiling is reached it aborts
// its signal, which is the runner's cancel signal: the current run stops at
// its next stage as run_cancelled, its data cleanup still runs, and no further
// run starts. No request is sent once the signal has aborted.
import { z } from 'zod';
import type { Ceilings } from './config.js';
import type { ModelDispatch } from '../models.js';

export const stopReasonSchema = z.enum([
  'max_model_calls',
  'max_tokens',
  'max_wall_time',
  // unknownUsage: stop, and a request's usage was not reported.
  'token_usage_unknown',
  // Cancelled by the user (Ctrl-C).
  'cancelled',
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const stopSchema = z
  .object({
    reason: stopReasonSchema,
    detail: z.string().min(1),
    // Milliseconds since the budget started.
    atMs: z.number().nonnegative(),
  })
  .strict();
export type Stop = z.infer<typeof stopSchema>;

const role = z.enum(['planner', 'selector']);
// One completed model call. Token counts are null when the provider did not
// report them: unknown, never zero.
export const callRecordSchema = z
  .object({
    target: z.string(),
    role,
    model: z.string(),
    durationMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type CallRecord = z.infer<typeof callRecordSchema>;

const tokenCount = z.number().int().nonnegative();
const usageSchema = z
  .object({
    prompt_tokens: tokenCount.optional(),
    completion_tokens: tokenCount.optional(),
    input_tokens: tokenCount.optional(),
    output_tokens: tokenCount.optional(),
  })
  .passthrough();
const callSchema = z.object({
  role,
  model: z.string(),
  durationMs: z.number().nonnegative(),
  response: z
    .object({ usage: usageSchema.nullish() })
    .passthrough()
    .nullish()
    .catch(null),
});

// Reported input/output tokens of a response; null for a count the provider
// did not report.
export function reportedUsage(response: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const parsed = callSchema.shape.response.parse(response);
  const usage = parsed?.usage;
  return {
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
  };
}

export class BenchmarkBudget {
  private readonly controller = new AbortController();
  private readonly started: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped: Stop | null = null;
  // The target whose runs are in progress; calls are attributed to it.
  target = '';
  readonly dispatched = { planner: 0, selector: 0 };
  readonly dispatchedByTarget = new Map<
    string,
    { planner: number; selector: number }
  >();
  readonly calls: CallRecord[] = [];
  // Tokens the providers reported.
  readonly tokens = { input: 0, output: 0 };

  constructor(
    readonly ceilings: Ceilings,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.started = now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get stop(): Stop | null {
    return this.stopped;
  }
  get elapsedMs(): number {
    return this.now() - this.started;
  }
  get totalDispatched(): number {
    return this.dispatched.planner + this.dispatched.selector;
  }
  // Requests sent whose usage is unknown: no usage in the response, or no
  // response at all (failed, timed out, aborted or rate-limited requests).
  get unknownUsage(): number {
    return (
      this.totalDispatched -
      this.calls.filter(
        (call) => call.inputTokens !== null && call.outputTokens !== null,
      ).length
    );
  }

  // Arms the wall-time ceiling.
  start(): void {
    if (this.timer || this.stopped) return;
    const remaining = this.ceilings.maxWallTimeMs - this.elapsedMs;
    this.timer = setTimeout(
      () =>
        this.halt(
          'max_wall_time',
          `wall time reached ${this.ceilings.maxWallTimeMs} ms`,
        ),
      Math.max(0, remaining),
    );
    this.timer.unref?.();
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  cancel(detail: string): void {
    this.halt('cancelled', detail);
  }

  private halt(reason: StopReason, detail: string): void {
    if (this.stopped) return;
    this.stopped = { reason, detail, atMs: this.elapsedMs };
    this.dispose();
    this.controller.abort(
      new DOMException(`Benchmark stopped: ${detail}`, 'AbortError'),
    );
  }

  // Called right before a request is sent; throws (and sends nothing) once any
  // ceiling is reached.
  beforeDispatch(data: Pick<ModelDispatch, 'role'>): void {
    if (!this.stopped) {
      if (this.elapsedMs >= this.ceilings.maxWallTimeMs)
        this.halt(
          'max_wall_time',
          `wall time reached ${this.ceilings.maxWallTimeMs} ms`,
        );
      else if (this.totalDispatched >= this.ceilings.maxModelCalls)
        this.halt(
          'max_model_calls',
          `${this.totalDispatched} model requests sent; maxModelCalls is ${this.ceilings.maxModelCalls}`,
        );
      else if (
        this.tokens.input + this.tokens.output >=
        this.ceilings.maxTokens
      )
        this.halt('max_tokens', this.tokenDetail());
      else if (this.ceilings.unknownUsage === 'stop' && this.unknownUsage > 0)
        this.halt('token_usage_unknown', this.unknownDetail());
    }
    if (this.stopped) throw this.signal.reason;
    this.dispatched[data.role]++;
    const target = this.dispatchedByTarget.get(this.target) ?? {
      planner: 0,
      selector: 0,
    };
    target[data.role]++;
    this.dispatchedByTarget.set(this.target, target);
  }

  // Called with each completed call (the onCall payload).
  recordCall(data: unknown): CallRecord | null {
    const call = callSchema.safeParse(data);
    if (!call.success) return null;
    const record: CallRecord = {
      target: this.target,
      role: call.data.role,
      model: call.data.model,
      durationMs: call.data.durationMs,
      ...reportedUsage(call.data.response),
    };
    this.calls.push(record);
    this.tokens.input += record.inputTokens ?? 0;
    this.tokens.output += record.outputTokens ?? 0;
    if (this.tokens.input + this.tokens.output >= this.ceilings.maxTokens)
      this.halt('max_tokens', this.tokenDetail());
    else if (
      this.ceilings.unknownUsage === 'stop' &&
      (record.inputTokens === null || record.outputTokens === null)
    )
      this.halt('token_usage_unknown', this.unknownDetail());
    return record;
  }

  private tokenDetail(): string {
    return `${this.tokens.input + this.tokens.output} reported tokens; maxTokens is ${this.ceilings.maxTokens}`;
  }
  private unknownDetail(): string {
    return `${this.unknownUsage} model request(s) without reported usage; the token ceiling cannot be enforced (unknownUsage: stop)`;
  }
}
