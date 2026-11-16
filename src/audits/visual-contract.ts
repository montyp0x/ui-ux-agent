// The visual baseline comparison record: what the `visual.baseline` audit
// reports beside its findings (on AuditOutput.visual and AuditRun.visual).
// Kept apart from src/audits/contract.ts so the comparison shape can grow
// without touching the generic audit contract.
import { z } from 'zod';

const count = z.number().int().nonnegative();

// match: compared with the approved baseline for this environment and within
// tolerance. mismatch: compared and over tolerance (a finding). missing: no
// approved baseline exists for this checkpoint and viewport (or no baseline
// directory was supplied). incompatible: baselines exist for this checkpoint
// and viewport, but none was approved in this rendering environment, so no
// comparison is meaningful. unstable: the page never rendered the same image
// twice in a row, so there is no current image to compare. Only match is a
// pass; missing, incompatible and unstable are never passes.
export const visualStatusSchema = z.enum([
  'match',
  'mismatch',
  'missing',
  'incompatible',
  'unstable',
]);
export type VisualStatus = z.infer<typeof visualStatusSchema>;

// Which baseline a capture belongs to. Every part is in the baseline path.
export const visualKeySchema = z
  .object({
    // The suite's name as configured; the path uses a slug of it.
    suite: z.string().min(1),
    journey: z.string().regex(/^[a-z0-9-]+$/),
    // The audit checkpoint: ready, state:<name> or completion.
    checkpoint: z.string().regex(/^(ready|completion|state:[a-z0-9-]+)$/),
    viewport: z.string().regex(/^[a-z0-9-]+$/),
    // The suite environment (src/environments.ts), for suites with
    // environments: each keeps its own baselines, so a dark or pseudo-
    // localized capture is never compared with another environment's.
    environment: z.string().regex(/^[a-z0-9-]+$/).optional(),
  })
  .strict();
export type VisualKey = z.infer<typeof visualKeySchema>;

// Everything that changes how the same UI renders. A baseline is compared only
// with a capture whose environment is identical; any difference makes the
// baseline incompatible, never a pass.
export const visualEnvironmentSchema = z
  .object({
    viewport: z.object({ width: count, height: count }).strict(),
    browser: z
      .object({
        // chromium | firefox | webkit
        name: z.string().min(1),
        version: z.string().min(1),
        // bundled, channel:<name> or executable
        build: z.string().min(1),
        headless: z.boolean(),
      })
      .strict(),
    os: z
      .object({
        // process.platform and process.arch of the machine that rendered it.
        platform: z.string().min(1),
        arch: z.string().min(1),
        // The OS release's major version (on macOS the Darwin kernel major,
        // which tracks the macOS major).
        release: z.string().min(1),
      })
      .strict(),
    deviceScaleFactor: z.number().positive(),
    locale: z.string().min(1),
    timezone: z.string().min(1),
    colorScheme: z.enum(['light', 'dark', 'no-preference']),
    reducedMotion: z.enum(['reduce', 'no-preference']),
    capture: z
      .object({
        fullPage: z.boolean(),
        // Configured mask selectors, in configuration order.
        masks: z.array(z.string().min(1)),
        // Whether the run's evidence protection (secret redaction and
        // suite.evidence masks) was applied to the capture.
        protected: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type VisualEnvironment = z.infer<typeof visualEnvironmentSchema>;

export const visualImageSchema = z
  .object({
    file: z.string().min(1),
    width: count,
    height: count,
    // SHA-256 of the PNG file, hex.
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type VisualImage = z.infer<typeof visualImageSchema>;

// A connected area of changed pixels, in CSS pixels of the capture.
export const visualRegionSchema = z
  .object({
    x: count,
    y: count,
    width: count,
    height: count,
    diffPixels: count,
  })
  .strict();
export type VisualRegion = z.infer<typeof visualRegionSchema>;

// A masked box in CSS pixels of the capture (whole pixels covering it).
export const visualRectSchema = z
  .object({ x: count, y: count, width: count, height: count })
  .strict();
export type VisualRect = z.infer<typeof visualRectSchema>;

export const visualToleranceSchema = z
  .object({
    // Per-pixel colour distance (pixelmatch threshold, 0..1) below which a
    // pixel counts as unchanged.
    threshold: z.number().min(0).max(1),
    // Changed pixels allowed in total, and as a fraction of the image.
    maxDiffPixels: count,
    maxDiffRatio: z.number().min(0).max(1),
  })
  .strict();
export type VisualTolerance = z.infer<typeof visualToleranceSchema>;

export const visualComparisonSchema = z
  .object({
    key: visualKeySchema,
    // Short hash of `environment`; names the baseline file.
    environmentId: z.string().regex(/^[0-9a-f]{16}$/),
    status: visualStatusSchema,
    environment: visualEnvironmentSchema,
    // The capture at this checkpoint, in the run directory. Null when the
    // page never settled (unstable).
    current: visualImageSchema.nullable(),
    // A copy of the approved baseline in the run directory, and when it was
    // approved. Null when none was compared.
    baseline: visualImageSchema
      .extend({
        approvedAt: z.iso.datetime(),
        maskedRegions: z.array(visualRectSchema).max(500),
      })
      .strict()
      .nullable(),
    // Boxes of every masked element in the current capture (the audit's
    // dynamic-region masks and the run's evidence protection). Pixels inside
    // these boxes or the baseline's are not compared: they are painted over
    // in both images. Everything outside them is.
    maskedRegions: z.array(visualRectSchema).max(500),
    // Changed pixels painted over a faded current image; null when nothing
    // was compared.
    diff: z.string().min(1).nullable(),
    // For incompatible: each environment field that differs from the most
    // recently approved baseline of this checkpoint and viewport.
    incompatible: z
      .array(
        z
          .object({
            field: z.string().min(1),
            baseline: z.string(),
            current: z.string(),
          })
          .strict(),
      )
      .max(40),
    // Aggregate difference; null when nothing was compared.
    pixels: z
      .object({
        diff: count,
        total: count,
        ratio: z.number().min(0).max(1),
        // True when baseline and current differ in size; the uncovered area
        // counts as changed.
        sizeChanged: z.boolean(),
      })
      .strict()
      .nullable(),
    // The largest changed regions, largest first; regionCount is the total.
    regions: z.array(visualRegionSchema).max(20),
    regionCount: count,
    tolerance: visualToleranceSchema,
    // Each configured mask and how many elements it covered in this capture.
    masks: z
      .array(z.object({ selector: z.string().min(1), matched: count }).strict())
      .max(50),
    // Screenshots taken until two consecutive ones were identical.
    captures: count,
  })
  .strict();
export type VisualComparison = z.infer<typeof visualComparisonSchema>;
