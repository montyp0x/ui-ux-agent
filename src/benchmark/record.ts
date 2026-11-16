// benchmark.json: what a benchmark ran (targets, pinned configuration,
// ceilings, why it stopped) and every model call's latency and reported
// tokens. Results stay in each target's results.json; reports are aggregated
// from both, so a report can be rebuilt (for example with reviewer labels)
// without running anything again.
import { z } from 'zod';
import { callRecordSchema, runRefSchema, stopSchema } from './budget.js';
import {
  BENCHMARK_VERSION,
  ceilingsSchema,
  pinnedModelSchema,
  targetSchema,
} from './config.js';

const countByRole = z
  .object({
    planner: z.number().int().nonnegative(),
    selector: z.number().int().nonnegative(),
  })
  .strict();

export const benchmarkRecordSchema = z
  .object({
    benchmarkVersion: z.literal(BENCHMARK_VERSION),
    // fixture: model responses came from a local fake; never a live measurement.
    mode: z.enum(['live', 'fixture']),
    name: z.string(),
    configPath: z.string(),
    configSha256: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    wallTimeMs: z.number().nonnegative(),
    engine: z
      .object({
        resultVersion: z.number().int(),
        auditContractVersion: z.number().int(),
        gitRevision: z.string().nullable(),
        // Uncommitted changes to tracked files when the benchmark ran.
        gitDirty: z.boolean().nullable(),
        node: z.string(),
        platform: z.string(),
      })
      .strict(),
    model: pinnedModelSchema,
    // Environment variables the pinned configuration overrode.
    overriddenEnv: z.array(z.string()),
    repeat: z.number().int(),
    ceilings: ceilingsSchema,
    stop: stopSchema.nullable(),
    targets: z.array(
      z
        .object({
          id: z.string(),
          suite: z.string(),
          suiteName: z.string(),
          sha256: z.string(),
          journey: z.string().nullable(),
          viewport: z.string().nullable(),
          reviewed: targetSchema.shape.reviewed,
          // Relative to the benchmark directory.
          directory: z.string(),
          planned: z.number().int().nonnegative(),
          started: z.boolean(),
          // The runner refused or failed to start the target.
          error: z.string().nullable(),
          dispatched: countByRole,
          // Its runs in start order and the requests each sent (retries
          // included); empty in records written before calls were
          // attributed to runs.
          runs: z
            .array(runRefSchema.extend({ dispatched: countByRole }).strict())
            .default([]),
        })
        .strict(),
    ),
    calls: z.array(callRecordSchema),
  })
  .strict();
export type BenchmarkRecord = z.infer<typeof benchmarkRecordSchema>;
