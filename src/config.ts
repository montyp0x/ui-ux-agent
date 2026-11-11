import { z } from 'zod';
import {
  DEFAULT_PLANNER_RATE_LIMIT,
  DEFAULT_SELECTOR_RATE_LIMIT,
  type ModelOptions,
  type RateLimit,
} from './models.js';

const headers = z.record(z.string(), z.string());

function parseHeaders(name: string, value: string | undefined) {
  if (!value) return {};
  try {
    return headers.parse(JSON.parse(value));
  } catch {
    throw new Error(`${name} must be a JSON object of string header values`);
  }
}

// Model configuration from environment variables, validated at startup. The
// default selector is TypeSafe Jev; SELECTOR_PROTOCOL=chat reuses the planner's
// OpenAI-compatible endpoint (overridable per SELECTOR_* variable), so a single
// provider key is enough.
// <PREFIX>_MAX_RPM and <PREFIX>_MAX_CONCURRENCY, validated; undefined keeps the default.
function rateLimit(
  env: Record<string, string | undefined>,
  prefix: 'PLANNER' | 'SELECTOR',
  fallback: RateLimit,
): RateLimit | undefined {
  const rpm = env[`${prefix}_MAX_RPM`];
  const concurrency = env[`${prefix}_MAX_CONCURRENCY`];
  if (rpm === undefined && concurrency === undefined) return undefined;
  const parse = (
    name: string,
    value: string | undefined,
    max: number,
    base: number,
  ) => {
    if (value === undefined) return base;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > max)
      throw new Error(`${name} must be an integer from 1 to ${max}`);
    return number;
  };
  return {
    rpm: parse(`${prefix}_MAX_RPM`, rpm, 6000, fallback.rpm),
    concurrency: parse(
      `${prefix}_MAX_CONCURRENCY`,
      concurrency,
      32,
      fallback.concurrency,
    ),
  };
}

export function modelOptionsFromEnv(
  env: Record<string, string | undefined>,
): ModelOptions {
  const limits = {
    plannerRateLimit: rateLimit(env, 'PLANNER', DEFAULT_PLANNER_RATE_LIMIT),
    selectorRateLimit: rateLimit(env, 'SELECTOR', DEFAULT_SELECTOR_RATE_LIMIT),
  };
  const required = (value: string | undefined, name: string) => {
    if (!value)
      throw new Error(
        `Missing ${name}; set it in the environment or .env (see .env.example), never in the suite file`,
      );
    return value;
  };
  const protocol = z
    .enum(['typesafe', 'chat'])
    .parse(env.SELECTOR_PROTOCOL ?? 'typesafe');
  const plannerURL =
    env.PLANNER_API_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
  const plannerKey = required(
    env.PLANNER_API_KEY ?? env.OPENROUTER_API_KEY,
    'PLANNER_API_KEY',
  );
  const plannerModel = env.PLANNER_MODEL ?? 'openai/gpt-6-astra';
  const plannerHeaders = parseHeaders(
    'PLANNER_API_HEADERS',
    env.PLANNER_API_HEADERS,
  );
  if (protocol === 'chat')
    return {
      ...limits,
      plannerURL,
      plannerKey,
      plannerModel,
      plannerHeaders,
      selectorProtocol: 'chat',
      selectorURL: env.SELECTOR_API_URL ?? plannerURL,
      selectorKey: env.SELECTOR_API_KEY ?? plannerKey,
      selectorModel: env.SELECTOR_MODEL ?? plannerModel,
      selectorHeaders: env.SELECTOR_API_HEADERS
        ? parseHeaders('SELECTOR_API_HEADERS', env.SELECTOR_API_HEADERS)
        : plannerHeaders,
    };
  return {
    ...limits,
    plannerURL,
    plannerKey,
    plannerModel,
    plannerHeaders,
    selectorProtocol: 'typesafe',
    selectorURL: env.SELECTOR_API_URL ?? 'https://api.typesafe.ai/v1/systemone',
    selectorKey: required(
      env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? env.SELECTOR_API_KEY,
      'JEV_API_KEY (or set SELECTOR_PROTOCOL=chat to use the planner endpoint)',
    ),
    selectorModel: env.SELECTOR_MODEL ?? 'jev-latest',
    selectorHeaders: parseHeaders(
      'SELECTOR_API_HEADERS',
      env.SELECTOR_API_HEADERS,
    ),
  };
}
