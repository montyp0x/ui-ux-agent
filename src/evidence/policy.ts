// The suite's evidence policy: what may leave the machine (provider-visible),
// what stays in the local run directory, and how each format is protected.
//
// Provider-visible (sent to the planner and selector endpoints, after text
// redaction): the journey goal and persona, the current URL, visible viewport
// text and control names and values, offered action descriptions and link
// destination paths, recent action history, the planner's objective, and —
// unless providerScreenshots is false — the masked viewport screenshot.
//
// Local-only (written to the run directory, never uploaded by the runner):
// everything else — the accessibility snapshot, fingerprints, selectors and
// configured values, the event log, results, the HTML report, screenshots,
// audit findings and files, traces and videos.
import { z } from 'zod';
import { targetSchema } from '../target.js';

const patternSchema = z
  .object({
    // A JavaScript regular expression source, matched anywhere in text.
    pattern: z.string().min(1),
    ignoreCase: z.boolean().default(false),
    // Shown in place of the match: [REDACTED:<label>].
    label: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(40)
      .optional(),
  })
  .strict();

// 'auto' captures the format unless something makes it unsafe (see
// evidenceFormats); 'off' never captures it; 'local' captures it unsanitized
// and is refused when the suite declares sensitive content.
const captureSchema = z.enum(['auto', 'local', 'off']);

export const evidencePolicySchema = z
  .object({
    // Text to redact from every text evidence path and model payload, and to
    // mask in screenshots where it is visible as page text or input values.
    redact: z.array(patternSchema).max(50).default([]),
    // Environment variables whose values are secret (for example an app
    // password a journey types). Variables whose names mark them as
    // credentials (…_KEY, …_TOKEN, …_SECRET, …_PASSWORD) are always redacted.
    redactEnv: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(50)
      .default([]),
    // Elements covered in every screenshot before it is captured (web only).
    masks: z.array(targetSchema).max(20).default([]),
    // Whether the planner receives the (masked) viewport screenshot.
    providerScreenshots: z.boolean().default(true),
    // Playwright trace (DOM snapshots, network log including cookies and
    // bodies, unmasked screenshots): cannot be sanitized.
    trace: captureSchema.default('auto'),
    // Screen recording requested with --video: cannot be masked.
    video: captureSchema.default('auto'),
    // Days after which `--prune-runs` may delete a run directory. Runs are
    // never deleted automatically.
    retentionDays: z.number().int().min(1).max(3650).default(30),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const [index, entry] of policy.redact.entries()) {
      let regex: RegExp;
      try {
        regex = new RegExp(entry.pattern, entry.ignoreCase ? 'i' : '');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['redact', index, 'pattern'],
          message: `Invalid redact pattern ${entry.pattern}`,
        });
        continue;
      }
      if (regex.test(''))
        ctx.addIssue({
          code: 'custom',
          path: ['redact', index, 'pattern'],
          message: `Redact pattern ${entry.pattern} matches empty text`,
        });
    }
    if (sensitive(policy))
      for (const format of ['trace', 'video'] as const)
        if (policy[format] === 'local')
          ctx.addIssue({
            code: 'custom',
            path: [format],
            message: `${format}: 'local' cannot be sanitized and this suite declares sensitive content (redact, redactEnv or masks); use 'auto' or 'off'`,
          });
  });
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;

// The policy a run applies (see suiteEvidencePolicy in contracts.ts): the
// suite's own, plus the keys of the secret dataLifecycle setup values its
// journeys use. Those values are only known once setup answers, but that a
// journey uses them is known at load, so they count as sensitive content.
// Once a run's setup answers, every secret value it returned is added too
// (EvidenceProtection.beginRun), referenced by a journey or not: the
// redaction policy treats it as a secret, so the run is sensitive.
export type RunEvidencePolicy = EvidencePolicy & {
  secretData?: readonly string[];
};

// The suite declares content it wants protected.
export function sensitive(
  policy: Pick<RunEvidencePolicy, 'redact' | 'redactEnv' | 'masks' | 'secretData'>,
): boolean {
  return (
    policy.redact.length > 0 ||
    policy.redactEnv.length > 0 ||
    policy.masks.length > 0 ||
    (policy.secretData?.length ?? 0) > 0
  );
}

export const EVIDENCE_FORMATS = [
  'model_payloads',
  'provider_screenshots',
  'screenshots',
  'trace',
  'video',
  'event_log',
  'results',
  'report',
  'audit_files',
] as const;
export const formatStatusSchema = z
  .object({
    format: z.enum(EVIDENCE_FORMATS),
    enabled: z.boolean(),
    // How enabled content is protected: text redaction, screenshot masks
    // applied before capture, or none (the format cannot be sanitized).
    protection: z.enum(['redacted', 'masked', 'not_sanitized']),
    // Leaves the machine (model endpoints) or stays in the run directory.
    destination: z.enum(['provider', 'local']),
    reason: z.string().min(1),
  })
  .strict();
export type FormatStatus = z.infer<typeof formatStatusSchema>;

export const evidenceReportSchema = z
  .object({
    // Counts only: patterns and values are never written to evidence.
    declaredPatterns: z.number().int().nonnegative(),
    builtInPatterns: z.number().int().nonnegative(),
    // Environment variables whose values are redacted (names only).
    redactedEnv: z.array(z.string()),
    // Keys of the run's dataLifecycle setup values that are redacted (the
    // values are never recorded).
    redactedData: z.array(z.string()).default([]),
    // What the protection could not cover in this run, for example a secret
    // too short to redact from text.
    limitations: z.array(z.string()).default([]),
    masks: z.number().int().nonnegative(),
    formats: z.array(formatStatusSchema),
    // Text files in the journey directory rewritten by the final sweep
    // (files written by drivers and audits).
    sanitizedFiles: z.number().int().nonnegative(),
  })
  .strict();
export type EvidenceReport = z.infer<typeof evidenceReportSchema>;

export type FormatContext = {
  platform: 'web' | 'macos';
  // The run uses a signed-in profile or a storage state.
  authenticated: boolean;
  // --video was passed.
  videoRequested: boolean;
};

// What each evidence format does for this suite and run.
export function evidenceFormats(
  policy: RunEvidencePolicy,
  context: FormatContext,
): FormatStatus[] {
  const declared = sensitive(policy);
  const native = context.platform === 'macos';
  // Native screenshots are window captures: nothing can be masked in them.
  const maskable = !native;
  const providerScreenshots =
    policy.providerScreenshots && (maskable || !declared);
  const suiteTrace =
    policy.trace === 'off'
      ? { enabled: false, reason: "disabled by the suite (trace: 'off')" }
      : native
        ? {
            enabled: true,
            reason: 'final accessibility tree (JSON), text redacted',
          }
        : policy.trace === 'local'
          ? {
              enabled: true,
              reason:
                "captured by the suite (trace: 'local'); holds DOM snapshots, network traffic and unmasked screenshots — keep local",
            }
          : declared
            ? {
                enabled: false,
                reason:
                  'disabled: Playwright traces hold DOM snapshots, network traffic and unmasked screenshots and cannot be sanitized; the suite declares sensitive content',
              }
            : context.authenticated
              ? {
                  enabled: false,
                  reason:
                    "disabled: an authenticated run's trace holds session cookies; set trace: 'local' to capture it",
                }
              : {
                  enabled: true,
                  reason:
                    'captured unsanitized: holds DOM snapshots, network traffic and unmasked screenshots — keep local',
                };
  const suiteVideo = !context.videoRequested
    ? { enabled: false, reason: 'not requested (--video)' }
    : native
      ? { enabled: false, reason: 'not supported by the macOS driver' }
      : policy.video === 'off'
        ? { enabled: false, reason: "disabled by the suite (video: 'off')" }
        : declared
          ? {
              enabled: false,
              reason:
                'disabled: screen recordings cannot be masked; the suite declares sensitive content',
            }
          : {
              enabled: true,
              reason: 'captured unmasked — keep local',
            };
  // Secret setup values a 'local' capture would record unsanitized. Values
  // the journeys use refuse 'local' at load; values setup returns that no
  // journey uses are only known once the run begins, so the capture is
  // turned off for the run instead.
  const secretData = policy.secretData ?? [];
  const unsanitizable = (format: 'trace' | 'video') =>
    !native && policy[format] === 'local' && secretData.length > 0
      ? {
          enabled: false,
          reason: `disabled: dataLifecycle setup returned secret values (${secretData.join(', ')}) that ${format}: 'local' cannot sanitize; list values that are not secret in dataLifecycle.publicValues`,
        }
      : null;
  const trace = unsanitizable('trace') ?? suiteTrace;
  const video = suiteVideo.enabled
    ? (unsanitizable('video') ?? suiteVideo)
    : suiteVideo;
  return [
    {
      format: 'model_payloads',
      enabled: true,
      protection: 'redacted',
      destination: 'provider',
      reason: 'planner and selector requests are built from redacted text',
    },
    {
      format: 'provider_screenshots',
      enabled: providerScreenshots,
      protection: 'masked',
      destination: 'provider',
      reason: providerScreenshots
        ? 'the planner receives the masked viewport screenshot'
        : !policy.providerScreenshots
          ? 'disabled by the suite (providerScreenshots: false)'
          : 'disabled: native screenshots cannot be masked and the suite declares sensitive content',
    },
    {
      format: 'screenshots',
      enabled: true,
      protection: maskable ? 'masked' : 'not_sanitized',
      destination: 'local',
      reason: maskable
        ? 'masks and redaction patterns are applied before capture'
        : 'native window captures cannot be masked — keep local',
    },
    {
      format: 'trace',
      enabled: trace.enabled,
      protection: native ? 'redacted' : 'not_sanitized',
      destination: 'local',
      reason: trace.reason,
    },
    {
      format: 'video',
      enabled: video.enabled,
      protection: 'not_sanitized',
      destination: 'local',
      reason: video.reason,
    },
    ...(['event_log', 'results', 'report', 'audit_files'] as const).map(
      (format) => ({
        format,
        enabled: true,
        protection: 'redacted' as const,
        destination: 'local' as const,
        reason: 'text redacted before it is written',
      }),
    ),
  ];
}

export function formatEnabled(
  formats: FormatStatus[],
  format: FormatStatus['format'],
): boolean {
  return formats.find((entry) => entry.format === format)?.enabled ?? false;
}
