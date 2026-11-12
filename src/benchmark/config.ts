// Benchmark configuration: a small, reviewed set of suites, a pinned model
// configuration, a repeat count and explicit ceilings. Parsed with Zod at the
// boundary; a config without every ceiling is refused.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { modelOptionsFromEnv } from '../config.js';
import { suiteSchema, type Suite } from '../contracts.js';
import { loadDesignTokens } from '../audits/design-tokens.js';
import type { ModelOptions } from '../models.js';

export const BENCHMARK_VERSION = 1;

// A model endpoint: http(s), no credentials, query string or fragment, so a
// key can never be pinned in the config (keys come from the environment).
const endpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'must be an http(s) URL without credentials, query string or fragment');

const rateLimitSchema = z
  .object({
    rpm: z.number().int().min(1).max(6000),
    concurrency: z.number().int().min(1).max(32),
  })
  .strict();

export const pinnedModelSchema = z
  .object({
    plannerURL: endpointSchema,
    plannerModel: z.string().min(1),
    selectorProtocol: z.enum(['typesafe', 'chat']),
    selectorURL: endpointSchema,
    selectorModel: z.string().min(1),
    plannerRateLimit: rateLimitSchema.optional(),
    selectorRateLimit: rateLimitSchema.optional(),
  })
  .strict();
export type PinnedModel = z.infer<typeof pinnedModelSchema>;

// Every ceiling is required; there are no defaults.
export const ceilingsSchema = z
  .object({
    // HTTP requests to the planner and selector endpoints, retries included.
    // A request past it is never sent.
    maxModelCalls: z.number().int().min(1).max(100_000),
    // Input plus output tokens the providers reported. Checked after each
    // response and before each request, so the total can pass it by at most
    // the one response that reached it.
    maxTokens: z.number().int().min(1).max(100_000_000),
    // Wall time of the whole benchmark, from the first run's start.
    maxWallTimeMs: z.number().int().min(1000).max(86_400_000),
    // A request whose provider reported no usage (or that failed without a
    // response) makes the token total unknown. stop: end the benchmark there,
    // so the token ceiling stays enforceable; continue: keep going, with the
    // token ceiling covering only reported usage.
    unknownUsage: z.enum(['stop', 'continue']),
  })
  .strict();
export type Ceilings = z.infer<typeof ceilingsSchema>;

export const targetSchema = z
  .object({
    // Names the target in reports and its run directory.
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and -'),
    // Suite file, relative to the benchmark config.
    suite: z.string().min(1),
    // Optional pin of the suite file's contents; a mismatch is refused.
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    // Limit the target to one journey and/or viewport of the suite.
    journey: z.string().min(1).optional(),
    viewport: z.string().min(1).optional(),
    // Dedicated sign-in profile or approved storage state, as for the CLI.
    profile: z.string().min(1).optional(),
    storageState: z.string().min(1).optional(),
    // Who reviewed this target (suite, data and allowed scope) for live runs.
    reviewed: z.object({ by: z.string().min(1), on: z.iso.date() }).strict(),
  })
  .strict()
  .refine((target) => !(target.profile && target.storageState), {
    message: 'use profile or storageState, not both',
  });
export type Target = z.infer<typeof targetSchema>;

export const benchmarkConfigSchema = z
  .object({
    benchmarkVersion: z.literal(BENCHMARK_VERSION),
    name: z.string().min(1).max(200),
    // A small reviewed set.
    targets: z.array(targetSchema).min(1).max(10),
    model: pinnedModelSchema,
    // Runs per journey/viewport; one run is not a pass rate.
    repeat: z.number().int().min(2).max(50),
    ceilings: ceilingsSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = config.targets.map((target) => target.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'target ids must be unique',
      });
  });
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;

export function parseBenchmarkConfig(raw: unknown): BenchmarkConfig {
  const parsed = benchmarkConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Benchmark config refused:\n${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

export type ResolvedTarget = Target & {
  suitePath: string;
  sha256: string;
  parsed: Suite;
};
export type LoadedBenchmark = {
  path: string;
  sha256: string;
  config: BenchmarkConfig;
  targets: ResolvedTarget[];
};

const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

// Reads and validates the config and every target suite.
export async function loadBenchmark(path: string): Promise<LoadedBenchmark> {
  const absolute = resolve(path);
  const text = await readFile(absolute, 'utf8');
  const config = parseBenchmarkConfig(JSON.parse(text));
  const targets: ResolvedTarget[] = [];
  for (const target of config.targets) {
    const suitePath = resolve(dirname(absolute), target.suite);
    const bytes = await readFile(suitePath);
    const digest = sha256(bytes);
    if (target.sha256 && target.sha256 !== digest)
      throw new Error(
        `Target ${target.id}: ${target.suite} does not match its pinned sha256 (found ${digest}); review the suite and update the pin`,
      );
    const parsed = await loadDesignTokens(
      suiteSchema.parse(JSON.parse(bytes.toString('utf8'))),
      suitePath,
    );
    if (
      target.journey &&
      !parsed.journeys.some((journey) => journey.id === target.journey)
    )
      throw new Error(`Target ${target.id}: no journey ${target.journey}`);
    if (
      target.viewport &&
      !parsed.viewports.some((viewport) => viewport.name === target.viewport)
    )
      throw new Error(`Target ${target.id}: no viewport ${target.viewport}`);
    if (parsed.requiresAuth && !target.profile && !target.storageState)
      throw new Error(
        `Target ${target.id}: the suite requires auth; set profile or storageState`,
      );
    targets.push({ ...target, suitePath, sha256: digest, parsed });
  }
  return { path: absolute, sha256: sha256(text), config, targets };
}

// Runs a target produces: its journeys x viewports x repeat.
export function plannedRuns(target: ResolvedTarget, repeat: number): number {
  const journeys = target.parsed.journeys.filter(
    (journey) => !target.journey || journey.id === target.journey,
  ).length;
  const viewports = target.parsed.viewports.filter(
    (viewport) => !target.viewport || viewport.name === target.viewport,
  ).length;
  return journeys * viewports * repeat;
}

// Model options from the environment (keys, headers) with the pinned values
// taking precedence over any PLANNER_*/SELECTOR_* endpoint, model, protocol or
// rate-limit variable. Returns the names of variables it overrode.
export function pinnedModelOptions(
  model: PinnedModel,
  env: Record<string, string | undefined>,
): { options: ModelOptions; overridden: string[] } {
  const pinned: Record<string, string | undefined> = {
    PLANNER_API_URL: model.plannerURL,
    PLANNER_MODEL: model.plannerModel,
    SELECTOR_PROTOCOL: model.selectorProtocol,
    SELECTOR_API_URL: model.selectorURL,
    SELECTOR_MODEL: model.selectorModel,
    PLANNER_MAX_RPM:
      model.plannerRateLimit && String(model.plannerRateLimit.rpm),
    PLANNER_MAX_CONCURRENCY:
      model.plannerRateLimit && String(model.plannerRateLimit.concurrency),
    SELECTOR_MAX_RPM:
      model.selectorRateLimit && String(model.selectorRateLimit.rpm),
    SELECTOR_MAX_CONCURRENCY:
      model.selectorRateLimit && String(model.selectorRateLimit.concurrency),
  };
  const merged = { ...env };
  const overridden: string[] = [];
  for (const [name, value] of Object.entries(pinned)) {
    if (env[name] !== undefined && env[name] !== value) overridden.push(name);
    // An unpinned rate limit uses the engine default, not the environment's.
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  return { options: modelOptionsFromEnv(merged), overridden };
}
