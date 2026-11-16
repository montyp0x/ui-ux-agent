// The friction-relevant events of a run, parsed at the boundary: as the runner
// writes them to events.jsonl (FrictionRecorder) and when a consumer reads
// events.jsonl back (eventLogRuns). Both paths parse the same written
// (redacted) event data, so a summary recomputed from the log is identical
// to the one the run recorded.
import { z } from 'zod';

const step = z.number().int();
const observationEvent = z.object({
  step,
  url: z.string(),
  screenshot: z.string(),
});
const actionEvent = z.object({
  kind: z.string().min(1),
  description: z.string(),
  // Links: the destination. History back: the target entry.
  href: z.string().optional(),
  url: z.string().optional(),
});
const schemas = {
  observation: observationEvent,
  content_observation: observationEvent,
  // A fresh observation for a declared state still pending when success held.
  state_observation: observationEvent,
  plan: z.object({
    step,
    refreshReasons: z.array(z.string()),
    plan: z.object({ concerns: z.array(z.unknown()) }),
  }),
  decision: z.object({ step, decision: z.object({ choice: z.string() }) }),
  loop_check: z.object({
    step,
    action: z.string(),
    visits: z.number().int().min(1),
    outcome: z.enum(['dispatch', 'replan', 'rejected']),
  }),
  action_result: z.object({
    step,
    action: actionEvent,
    source: z.enum(['selector', 'recovery']),
    changed: z.boolean(),
    error: z.string().nullable(),
  }),
  detour: z.object({
    step,
    path: z.string(),
    description: z.string(),
    visits: z.number().int().min(1),
  }),
  recovery: z.object({
    step,
    reason: z.string(),
    attempt: z.number().int().min(1),
    limit: z.number().int().min(1),
  }),
} as const;
type Schemas = typeof schemas;
export type FrictionEventName = keyof Schemas;
export type FrictionEvent = {
  [K in FrictionEventName]: {
    event: K;
    line: number;
    data: z.infer<Schemas[K]>;
  };
}[FrictionEventName];

export const FRICTION_EVENTS = Object.keys(schemas) as FrictionEventName[];
const relevant = (event: string): event is FrictionEventName =>
  Object.hasOwn(schemas, event);

// The events one run's friction summary is computed from.
export type FrictionLog = {
  readonly events: readonly FrictionEvent[];
  // Friction-relevant events that did not match their contract.
  readonly unparsed: number;
};

export class FrictionRecorder implements FrictionLog {
  readonly events: FrictionEvent[] = [];
  unparsed = 0;
  // line: the event's 1-based events.jsonl line; data: as written.
  record(line: number, event: string, data: unknown): void {
    if (!relevant(event)) return;
    const parsed = schemas[event].safeParse(data);
    if (!parsed.success) {
      this.unparsed++;
      return;
    }
    this.events.push({ event, line, data: parsed.data } as FrictionEvent);
  }
}

const logLine = z.object({ event: z.string(), data: z.unknown() });
const journeyStart = z.object({
  journey: z.string(),
  viewport: z.string(),
  attempt: z.number().int().min(1),
});

export type EventLogRun = FrictionLog & {
  journey: string;
  viewport: string;
  attempt: number;
};

// Splits an events.jsonl text into its runs (journey_start up to
// journey_finished; runs are sequential) with each run's friction events.
export function eventLogRuns(text: string): EventLogRun[] {
  const runs: { start: z.infer<typeof journeyStart>; log: FrictionRecorder }[] =
    [];
  let current: FrictionRecorder | null = null;
  text.split('\n').forEach((raw, index) => {
    if (!raw.trim()) return;
    const entry = logLine.parse(JSON.parse(raw));
    if (entry.event === 'journey_start') {
      current = new FrictionRecorder();
      runs.push({ start: journeyStart.parse(entry.data), log: current });
    } else if (entry.event === 'journey_finished') current = null;
    else current?.record(index + 1, entry.event, entry.data);
  });
  return runs.map(({ start, log }) => ({
    journey: start.journey,
    viewport: start.viewport,
    attempt: start.attempt,
    events: log.events,
    unparsed: log.unparsed,
  }));
}
