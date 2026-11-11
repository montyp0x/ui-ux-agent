import { z } from 'zod';
import { auditsConfigSchema, journeyStateSchema } from './audits/config.js';
import { targetSchema, type Target } from './target.js';

export { targetSchema, type Target };

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
    // Steps run once after ready and before the first observation, to reach a
    // known starting state (e.g. clear a calculator). Each must match the
    // target of an offered action: a discovered control or an interaction.
    setup: z.array(interactionSchema).max(10).optional(),
    // Declared states where audits configured with at: 'states' run, once,
    // at the first observed state where `when` holds.
    states: z.array(journeyStateSchema(checkSchema)).max(10).optional(),
    discoverRoles: z.array(z.enum(['button', 'tab', 'menuitem'])).default([]),
    maxSteps: z.number().int().min(1).max(100).default(20),
    maxDurationMs: z.number().int().min(1000).max(900000).default(180000),
  })
  .strict();
export type Journey = z.infer<typeof journeySchema>;
// Control names never offered to the agent in native apps unless a suite
// configures them explicitly as interactions. Suites can add patterns.
export const DEFAULT_BLOCKED_CONTROLS = [
  '\\b(delete|remove|erase|trash|discard|destroy)\\b',
  '\\b(send|post|publish|share|submit)\\b',
  '\\b(buy|purchase|pay|subscribe|order|checkout)\\b',
  '\\b(quit|close|log ?out|sign ?out|shut ?down|restart|uninstall)\\b',
  '\\b(empty|reset|format (disk|drive|volume|card)|wipe|revoke)\\b',
  // Services and agents running on the machine.
  '\\b(install|upgrade|stop|pause|disable|deactivate|disconnect|unlink)\\b',
  // File side effects on the user's machine.
  '\\b(save|export|overwrite|replace|rename|duplicate|move to)\\b',
];

// Additionally blocked for menu commands: they reveal files, leave the window,
// or act outside the app. Matched against each menu path segment.
export const MENU_BLOCKED_CONTROLS = [
  '\\b(open|recent|import|print|page setup|share|services)\\b',
  '\\b(hide|minimi[sz]e|zoom|full ?screen|bring all to front|revert)\\b',
  // System-provided items that act outside the app (microphone, system
  // panels, passwords, AI text services, audio).
  '\\b(dictation|emoji|symbols|autofill|passwords?|contacts|keychain|writing tools|speech|speaking)\\b',
];
// Whole menus never offered: system (Apple menu is skipped by the helper),
// window management and help (opens other apps).
export const EXCLUDED_MENUS = ['Window', 'Help'];

const appSchema = z
  .object({
    // Identity used for scope checks; required unless path is given.
    bundleId: z.string().min(1).optional(),
    // A .app bundle to launch, for apps that are not installed.
    path: z.string().min(1).optional(),
    // Quit (gracefully) and relaunch at session start for a known initial
    // state. Off by default: quitting can lose a user's unsaved work.
    relaunch: z.boolean().default(false),
  })
  .strict()
  .refine((app) => app.bundleId || app.path, 'app needs bundleId or path');

// Native suites have no URLs: fill the web-only fields with neutral values so
// the engine's types stay unchanged. Observations use macos-app://<app>/<title>.
function nativeDefaults(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const suite = raw as Record<string, unknown>;
  if (suite.platform !== 'macos') return raw;
  const app = (suite.app ?? {}) as { bundleId?: string; path?: string };
  const host = (app.bundleId ?? 'local-app')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-');
  return {
    ...suite,
    baseURL: suite.baseURL ?? `macos-app://${host}`,
    viewports: suite.viewports ?? [
      { name: 'window', width: 1024, height: 768 },
    ],
    journeys: Array.isArray(suite.journeys)
      ? suite.journeys.map((journey) =>
          journey && typeof journey === 'object'
            ? { startPath: '/', allowedPaths: ['/'], ...journey }
            : journey,
        )
      : suite.journeys,
  };
}

const suiteObject = z
  .object({
    name: z.string().min(1),
    platform: z.enum(['web', 'macos']).default('web'),
    app: appSchema.optional(),
    blockedControls: z.array(z.string().min(1)).max(50).default([]),
    // macOS: offer menu-bar commands (opt-in; see MENU_BLOCKED_CONTROLS).
    menus: z.boolean().default(false),
    baseURL: z.url(),
    browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    // An installed browser build for chromium (e.g. 'chrome'): uses the
    // system's proxy settings and certificate trust like a user's browser.
    browserChannel: z.enum(['chrome', 'chrome-beta', 'msedge']).optional(),
    // Absolute path to another Chromium-based browser's executable (e.g.
    // /Applications/Dia.app/Contents/MacOS/Dia). Launched with a fresh or a
    // dedicated --profile test profile, never the user's own.
    browserExecutable: z.string().regex(/^\//).optional(),
    requiresAuth: z.boolean().default(false),
    allowedOrigins: z.array(originSchema).default([]),
    applicationOrigins: z.array(originSchema).default([]),
    // Reviewed write requests. Use an exact path, or a pathPattern (regex on
    // the URL path) for endpoints with ids, such as chat message routes.
    allowedRequests: z
      .array(
        z
          .object({
            origin: originSchema,
            path: relativePath.optional(),
            pathPattern: z.string().min(2).optional(),
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
          })
          .strict()
          .refine(
            (rule) => !!rule.path !== !!rule.pathPattern,
            'allowedRequests entries need exactly one of path or pathPattern',
          ),
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
    // Objective audits run at configured checkpoints (see src/audits/).
    // Default: the horizontal overflow audit at completion, fail on serious.
    audits: auditsConfigSchema.prefault({}),
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
    if (suite.platform === 'macos') {
      if (!suite.app)
        ctx.addIssue({ code: 'custom', message: 'macOS suites need app' });
      if (
        suite.allowedOrigins.length ||
        suite.applicationOrigins.length ||
        suite.allowedRequests.length ||
        suite.readOnlyPosts.length ||
        suite.requiresAuth
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Web request and session settings do not apply to macOS suites',
        });
      for (const pattern of suite.blockedControls)
        try {
          new RegExp(pattern, 'i');
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid blockedControls regex ${pattern}`,
          });
        }
      const targets = suite.journeys.flatMap((journey) => [
        ...journey.interactions.map((interaction) => interaction.target),
        ...[
          journey.ready,
          ...journey.success,
          ...(journey.contentReady?.checks ?? []),
          ...(journey.states ?? []).flatMap((state) => [
            state.when,
            ...(state.expect ?? []),
          ]),
        ].flatMap((check) => ('target' in check ? [check.target] : [])),
      ]);
      if (targets.some((target) => target.by === 'css'))
        ctx.addIssue({
          code: 'custom',
          message:
            'CSS targets do not apply to macOS; use role, testId (accessibility identifier), label or placeholder',
        });
      // A key press would have to be synthesized: the driver only performs
      // actions that accessibility elements offer.
      if (
        suite.journeys.some((journey) =>
          [...journey.interactions, ...(journey.setup ?? [])].some(
            (interaction) => interaction.kind === 'press',
          ),
        )
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'press interactions are not supported on macOS: the driver never synthesizes keyboard input',
        });
    } else if (suite.menus)
      ctx.addIssue({
        code: 'custom',
        message: 'menus applies to macOS suites only',
      });
    else if (!['http:', 'https:'].includes(new URL(suite.baseURL).protocol))
      ctx.addIssue({ code: 'custom', message: 'baseURL must be HTTP(S)' });
    for (const rule of suite.allowedRequests)
      if (rule.pathPattern)
        try {
          new RegExp(rule.pathPattern);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid pathPattern ${rule.pathPattern}`,
          });
        }
    if (
      (suite.browserChannel || suite.browserExecutable) &&
      suite.browser !== 'chromium'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'browserChannel and browserExecutable apply to chromium only',
      });
    if (suite.browserChannel && suite.browserExecutable)
      ctx.addIssue({
        code: 'custom',
        message: 'Use browserChannel or browserExecutable, not both',
      });
    const auditsAtStates = suite.audits.checks.some((check) =>
      (check.at as string[]).includes('states'),
    );
    for (const journey of suite.journeys) {
      const states = (journey.states ?? []).map((state) => state.name);
      if (new Set(states).size !== states.length)
        ctx.addIssue({
          code: 'custom',
          message: `State names must be unique in ${journey.id}`,
        });
      if (states.length && !auditsAtStates)
        ctx.addIssue({
          code: 'custom',
          message: `${journey.id} declares states but no audit runs at 'states'`,
        });
      if (
        (journey.states ?? []).some((state) => state.expect?.length) &&
        !suite.audits.checks.some((check) => check.id === 'journey.state-checks')
      )
        ctx.addIssue({
          code: 'custom',
          message: `${journey.id} declares state expect checks; add the journey.state-checks audit so they are evaluated`,
        });
      for (const check of [
        journey.ready,
        ...journey.success,
        ...(journey.contentReady?.checks ?? []),
        ...(journey.states ?? []).flatMap((state) => [
          state.when,
          ...(state.expect ?? []),
        ]),
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
export const suiteSchema = z.preprocess(nativeDefaults, suiteObject);
export type Suite = z.infer<typeof suiteObject>;
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
  | { kind: 'wait'; id: string; description: string }
  // Browser history back to an in-scope previous entry (url).
  | { kind: 'back'; id: string; description: string; url: string };
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
// The run result contract lives in results.ts; re-exported for existing imports.
export type { Finding, Result } from './results.js';
