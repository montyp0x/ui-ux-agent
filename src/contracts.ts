import { z } from 'zod';

const relativePath = z
  .string()
  .regex(/^\/(?!\/)/)
  .refine((value) => !value.includes('\\'));
const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  );
}, 'Origins must be HTTP(S) origins without credentials, paths, queries or fragments');
export const targetSchema = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('role'),
      role: z.enum([
        'button',
        'link',
        'textbox',
        'searchbox',
        'tab',
        'combobox',
        'heading',
        'dialog',
        'region',
        'checkbox',
        'radio',
        'menuitem',
        'option',
      ]),
      name: z.string().min(1),
    })
    .strict(),
  z.object({ by: z.literal('testId'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('label'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('placeholder'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('css'), value: z.string().min(1) }).strict(),
]);
export type Target = z.infer<typeof targetSchema>;
export const checkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), pattern: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('visible'), target: targetSchema }).strict(),
  z.object({ kind: z.literal('anyVisible'), target: targetSchema }).strict(),
  z.object({ kind: z.literal('anyRendered'), target: targetSchema }).strict(),
  z.object({ kind: z.literal('notVisible'), target: targetSchema }).strict(),
  z
    .object({
      kind: z.literal('text'),
      target: targetSchema,
      pattern: z.string().min(1),
    })
    .strict(),
]);
export type Check = z.infer<typeof checkSchema>;
const interactionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('select'),
      target: targetSchema,
      description: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('check'),
      target: targetSchema,
      description: z.string().min(1),
      checked: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('click'),
      target: targetSchema,
      description: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fill'),
      target: targetSchema,
      description: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('press'),
      target: targetSchema,
      description: z.string().min(1),
      key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp']),
    })
    .strict(),
]);
export const journeySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    goal: z.string().min(1),
    persona: z.string().min(1),
    startPath: relativePath,
    allowedPaths: z.array(relativePath).min(1),
    ready: checkSchema,
    success: z.array(checkSchema).min(1),
    contentReady: z
      .object({
        checks: z.array(checkSchema).min(1),
        timeoutMs: z.number().int().min(200).max(60000).default(10000),
      })
      .strict()
      .optional(),
    loopProgressTargets: z.array(targetSchema).max(10).optional(),
    // Pages that resemble the destination but are not it. Visits are reported
    // as observed UX findings; the planner is not told about them.
    detours: z
      .array(
        z
          .object({
            pattern: z.string().min(1),
            description: z.string().min(1),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    interactions: z.array(interactionSchema).default([]),
    discoverRoles: z.array(z.enum(['button', 'tab', 'menuitem'])).default([]),
    maxSteps: z.number().int().min(1).max(100).default(20),
    maxDurationMs: z.number().int().min(1000).max(900000).default(180000),
  })
  .strict();
export type Journey = z.infer<typeof journeySchema>;
export const suiteSchema = z
  .object({
    name: z.string().min(1),
    baseURL: z.url(),
    browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    requiresAuth: z.boolean().default(false),
    allowedOrigins: z.array(originSchema).default([]),
    applicationOrigins: z.array(originSchema).default([]),
    allowedRequests: z
      .array(
        z
          .object({
            origin: originSchema,
            path: relativePath,
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
          })
          .strict(),
      )
      .default([]),
    viewports: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9-]+$/),
            width: z.number().int().min(320).max(3840),
            height: z.number().int().min(480).max(2160),
          })
          .strict(),
      )
      .min(1),
    readOnlyPosts: z
      .array(z.object({ origin: originSchema, path: relativePath }).strict())
      .default([]),
    journeys: z.array(journeySchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    for (const values of [
      suite.journeys.map((j) => j.id),
      suite.viewports.map((v) => v.name),
    ]) {
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Journey and viewport names must be unique',
        });
    }
    if (!['http:', 'https:'].includes(new URL(suite.baseURL).protocol))
      ctx.addIssue({ code: 'custom', message: 'baseURL must be HTTP(S)' });
    for (const journey of suite.journeys) {
      for (const check of [
        journey.ready,
        ...journey.success,
        ...(journey.contentReady?.checks ?? []),
        ...(journey.detours ?? []).map((detour) => ({
          kind: 'path' as const,
          pattern: detour.pattern,
        })),
      ]) {
        if (check.kind === 'path' || check.kind === 'text') {
          try {
            new RegExp(check.pattern);
          } catch {
            ctx.addIssue({
              code: 'custom',
              message: `Invalid regex in ${journey.id}`,
            });
          }
        }
      }
    }
  });
export type Suite = z.infer<typeof suiteSchema>;
export type Action =
  | {
      kind: 'link';
      id: string;
      description: string;
      target: Target;
      href: string;
    }
  | (z.infer<typeof interactionSchema> & { id: string })
  | {
      kind: 'scroll';
      id: string;
      description: string;
      direction: 'up' | 'down';
      region: string;
      point: ScrollPoint;
    }
  | { kind: 'wait'; id: string; description: string };
export type ScrollPoint = { x: number; y: number };
export type ScrollRegion = {
  id: string;
  label: string;
  parent: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
  up: ScrollPoint | null;
  down: ScrollPoint | null;
};
export type Viewport = {
  width: number;
  height: number;
  text: string;
  textTruncated: boolean;
  controls: {
    role: string;
    name: string;
    value?: string;
    checked?: boolean;
    disabled: boolean;
  }[];
  canScrollUp: boolean;
  canScrollDown: boolean;
  scrollRegions: ScrollRegion[];
};
export type Observation = {
  step: number;
  url: string;
  snapshot: string;
  screenshot: string;
  visibleViewport: Viewport;
  fingerprint: string;
  scroll: {
    x: number;
    y: number;
    containers: { index: number; x: number; y: number }[];
  };
  horizontalOverflow: number;
};
export const planSchema = z
  .object({
    objective: z.string().min(1),
    concerns: z
      .array(
        z
          .object({ symptom: z.string().min(1), userImpact: z.string().min(1) })
          .strict(),
      )
      .max(6),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export const choiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
export type Choice = z.infer<typeof choiceSchema>;
export type Finding = {
  kind: 'observed' | 'hypothesis';
  category: string;
  description: string;
  step: number;
  screenshot: string;
};
export type Result = {
  journey: string;
  viewport: string;
  status: 'passed' | 'failed' | 'blocked' | 'error';
  reason: string;
  steps: number;
  durationMs: number;
  checks: boolean[];
  findings: Finding[];
  trace: string;
  video: string | null;
};
