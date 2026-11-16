// Run identity: what a run measured, so two runs can be compared only when
// they measured the same thing (src/compare.ts). Recorded on every result as
// `identity` (optional in the result contract; runs from older engines lack
// it and cannot be compared).
//
// Nothing here is guessed: the build is what the caller passed (--build or
// UIUX_BUILD), and is null otherwise; model configuration is the endpoints
// and model names the CLI was configured with (never keys or headers), and
// null for a custom `Models` implementation.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { z } from 'zod';
import type { Suite } from './contracts.js';
import type { ModelOptions } from './models.js';
import type { Redactor } from './evidence/redact.js';

export const IDENTITY_VERSION = 1;

// The engine's own version, from package.json. Bump it when a change can
// alter what a suite measures (journey execution, audits, normalization).
export const ENGINE_VERSION = z
  .object({ version: z.string().min(1) })
  .parse(
    JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ),
  ).version;

export const buildIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s]+$/, 'A build id is one token without whitespace');

export const buildSchema = z
  .object({
    // The build or revision of the application under test, as given.
    id: buildIdSchema,
    // Where it came from: the --build flag, the UIUX_BUILD variable, or a
    // library caller's RunOptions.build.
    source: z.enum(['cli', 'env', 'option']),
  })
  .strict();
export type Build = z.infer<typeof buildSchema>;

const endpointSchema = z
  .object({
    protocol: z.enum(['chat', 'typesafe']),
    // Origin and path only: no user info, query or fragment.
    endpoint: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export const modelIdentitySchema = z
  .object({ planner: endpointSchema, selector: endpointSchema })
  .strict();
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;

export const browserIdentitySchema = z
  .object({
    name: z.string().min(1),
    // Null when the driver could not read it.
    version: z.string().min(1).nullable(),
    // bundled, channel:<name> or executable
    build: z.string().min(1),
    headless: z.boolean(),
  })
  .strict();
export type BrowserIdentity = z.infer<typeof browserIdentitySchema>;

// What a driver reports about itself (UIDriver.environment).
export type DriverEnvironment = {
  driver: string;
  browser: BrowserIdentity | null;
};

export const runIdentitySchema = z
  .object({
    identityVersion: z.literal(IDENTITY_VERSION),
    build: buildSchema.nullable(),
    suite: z
      .object({
        name: z.string(),
        // SHA-256 of the normalized, redacted suite configuration, without
        // baseURL (the deployment under test) and evidence.retentionDays.
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        // The deployment under test: scheme and host of baseURL.
        target: z.string().nullable(),
        // What this run selected from the suite.
        selection: z
          .object({
            journeys: z.array(z.string()),
            viewports: z.array(z.string()),
            repeat: z.number().int().min(1),
            // Suites with environments: the <environment>/<viewport>
            // combinations run, in order. Absent otherwise (every selected
            // viewport ran once per repeat, with no environment). What each
            // environment emulates is part of the suite hash.
            combinations: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      })
      .strict(),
    engine: z
      .object({
        version: z.string().min(1),
        resultVersion: z.number().int().min(1),
        auditContractVersion: z.number().int().min(1),
      })
      .strict(),
    environment: z
      .object({
        platform: z.enum(['web', 'macos']),
        // playwright, macos, or custom (a library caller's driver).
        driver: z.string().min(1),
        browser: browserIdentitySchema.nullable(),
        os: z
          .object({
            platform: z.string().min(1),
            arch: z.string().min(1),
            // Major release only.
            release: z.string().min(1),
          })
          .strict(),
        node: z.string().min(1),
      })
      .strict(),
    // Null for a custom Models implementation (scripted decisions).
    models: modelIdentitySchema.nullable(),
  })
  .strict();
export type RunIdentity = z.infer<typeof runIdentitySchema>;

// JSON with object keys sorted at every level, so equal values hash equally.
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// The suite as it decides what a run measures. Hashed after redaction, so
// secret values never feed the hash and rotating one does not change it.
// baseURL is left out: a new deployment of the same suite (another preview
// host) is the comparison's purpose, and is recorded as `target`.
export function suiteHash(suite: Suite, redactor: Redactor): string {
  const { baseURL: _baseURL, ...rest } = redactor.deep(suite);
  const { retentionDays: _retention, ...evidence } = rest.evidence;
  return sha256(canonicalJSON({ ...rest, evidence }));
}

export function suiteTarget(baseURL: string): string | null {
  try {
    const url = new URL(baseURL);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

// Origin and path of a model endpoint; never user info, query or fragment,
// which can carry keys.
export function endpointIdentity(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

export function modelIdentity(options: ModelOptions): ModelIdentity {
  return {
    planner: {
      protocol: 'chat',
      endpoint: endpointIdentity(options.plannerURL),
      model: options.plannerModel,
    },
    selector: {
      protocol: options.selectorProtocol ?? 'typesafe',
      endpoint: endpointIdentity(options.selectorURL),
      model: options.selectorModel,
    },
  };
}

// The build id from --build, else UIUX_BUILD, else null (unknown).
export function buildFrom(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): Build | null {
  const parse = (value: string, name: string) => {
    const parsed = buildIdSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        `${name} must be one token of 1-200 characters without whitespace`,
      );
    return parsed.data;
  };
  if (flag !== undefined) return { id: parse(flag, '--build'), source: 'cli' };
  if (env.UIUX_BUILD)
    return { id: parse(env.UIUX_BUILD, 'UIUX_BUILD'), source: 'env' };
  return null;
}

export function osIdentity(): RunIdentity['environment']['os'] {
  return {
    platform: platform(),
    arch: arch(),
    release: release().split('.')[0] ?? release(),
  };
}
