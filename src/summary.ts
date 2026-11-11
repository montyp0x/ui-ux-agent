import { z } from 'zod';
import type { OutcomeCategory, Quality, Result, Usage } from './results.js';

export type { CallStats, Usage } from './results.js';
export const emptyUsage = (): Usage => ({
  planner: { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
  selector: { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
});

// model_call event payloads as the model adapters log them. Token counts are
// read from OpenAI-style (prompt/completion) or input/output usage fields and
// count as zero when a provider omits them.
const modelCallSchema = z.object({
  role: z.enum(['planner', 'selector']),
  durationMs: z.number().nonnegative(),
  response: z
    .object({
      usage: z
        .object({
          prompt_tokens: z.number().optional(),
          completion_tokens: z.number().optional(),
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .nullish(),
});

export function addModelCall(usage: Usage, data: unknown): void {
  const call = modelCallSchema.safeParse(data);
  if (!call.success) return;
  const stats = usage[call.data.role];
  const tokens = call.data.response?.usage;
  stats.calls++;
  stats.durationMs += call.data.durationMs;
  stats.inputTokens += tokens?.prompt_tokens ?? tokens?.input_tokens ?? 0;
  stats.outputTokens += tokens?.completion_tokens ?? tokens?.output_tokens ?? 0;
}

export type JourneySummary = {
  journey: string;
  viewport: string;
  runs: number;
  passed: number;
  statuses: Record<Result['status'], number>;
  reasons: Record<string, number>;
  // Non-passing runs per outcome category (see results.ts).
  categories: Partial<Record<OutcomeCategory, number>>;
  // Quality verdicts, counted separately from the functional outcome.
  quality: Record<Quality['verdict'], number>;
  medianSteps: number;
  medianDurationMs: number;
  tokens: { input: number; output: number };
  modelCalls: { planner: number; selector: number };
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

// Pass rate and distributions per journey/viewport across repeated runs.
export function summarize(results: Result[]): JourneySummary[] {
  const groups = new Map<string, Result[]>();
  for (const result of results) {
    const key = `${result.journey}\u0000${result.viewport}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()].map((runs) => {
    const statuses = { passed: 0, failed: 0, blocked: 0, error: 0 };
    const reasons: Record<string, number> = {};
    const categories: JourneySummary['categories'] = {};
    const quality = { pass: 0, fail: 0, not_evaluated: 0 };
    for (const run of runs) {
      statuses[run.status]++;
      quality[run.quality.verdict]++;
      if (run.status !== 'passed') {
        reasons[run.reason] = (reasons[run.reason] ?? 0) + 1;
        const category = run.outcome.category;
        categories[category] = (categories[category] ?? 0) + 1;
      }
    }
    const sum = (pick: (usage: Usage) => number) =>
      runs.reduce((total, run) => total + pick(run.usage), 0);
    return {
      journey: runs[0]!.journey,
      viewport: runs[0]!.viewport,
      runs: runs.length,
      passed: statuses.passed,
      statuses,
      reasons,
      categories,
      quality,
      medianSteps: median(runs.map((run) => run.steps)),
      medianDurationMs: median(runs.map((run) => run.durationMs)),
      tokens: {
        input: sum(
          (usage) => usage.planner.inputTokens + usage.selector.inputTokens,
        ),
        output: sum(
          (usage) => usage.planner.outputTokens + usage.selector.outputTokens,
        ),
      },
      modelCalls: {
        planner: sum((usage) => usage.planner.calls),
        selector: sum((usage) => usage.selector.calls),
      },
    };
  });
}
