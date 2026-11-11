// Reviewed visual baselines (the `visual.baseline` audit): its configuration,
// the compatibility key, the local baseline store, the image comparison and
// the mapping onto the audit contract. Capture is driver code
// (src/drivers/playwright-visual.ts); approval is src/baselines.ts.
//
// A run never writes a baseline. Every capture is kept in the run directory
// and becomes a baseline only through an explicit approval, so the current
// output is never auto-approved. Baselines live in a directory the user
// supplies, outside Git (see assertOutsideGit in src/baselines.ts).
import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { z } from 'zod';
import type { AuditConfig } from './config.js';
import type { AuditOutput, AuditOutputFinding, Severity } from './contract.js';
import type { AuditDefinition } from './registry.js';
import {
  visualEnvironmentSchema,
  visualKeySchema,
  type VisualComparison,
  type VisualEnvironment,
  type VisualImage,
  type VisualKey,
  type VisualRegion,
  type VisualTolerance,
} from './visual-contract.js';

// The analyzer behind the comparison, pinned in package.json.
export const PIXELMATCH_VERSION = '8.0.0';

// Calibrated on the stable local fixtures in test/visual-baseline.test.ts:
// repeated captures of the same page in one environment differ by 0 pixels,
// and the smallest seeded change there (one changed word) is well over the
// pixel allowance. See the README's visual baselines section.
export const DEFAULT_TOLERANCE: VisualTolerance = {
  threshold: 0.1,
  maxDiffPixels: 0,
  maxDiffRatio: 0,
};

// Fields of the visual.baseline audit entry (spread into src/audits/config.ts).
export const visualAuditConfigShape = {
  // CSS selectors of dynamic regions (clocks, avatars, ads ...) painted over
  // with a solid colour in every capture, baseline and current alike. A mask
  // hides only what it covers: a masked element that moves or resizes still
  // shows as a change. Suite configuration only, never model output.
  mask: z.array(z.string().min(1).max(200)).max(50).default([]),
  // The whole scrollable page instead of the viewport.
  fullPage: z.boolean().default(false),
  threshold: z.number().min(0).max(1).default(DEFAULT_TOLERANCE.threshold),
  maxDiffPixels: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(DEFAULT_TOLERANCE.maxDiffPixels),
  maxDiffRatio: z.number().min(0).max(1).default(DEFAULT_TOLERANCE.maxDiffRatio),
  // Severity of a mismatch finding; it gates quality at or above failOn.
  severity: z
    .enum(['minor', 'moderate', 'serious', 'critical'])
    .default('serious'),
  // Screenshots taken, at most, until two consecutive ones are identical.
  maxCaptures: z.number().int().min(2).max(20).default(5),
  // Best-effort wait for the network to go idle before the first capture;
  // 0 skips it.
  networkIdleMs: z.number().int().min(0).max(30000).default(2000),
};

export type VisualBaselineConfig = Extract<AuditConfig, { id: 'visual.baseline' }>;

export const visualBaselineAudit: AuditDefinition<VisualBaselineConfig> = {
  id: 'visual.baseline',
  source: 'builtin',
  title: 'Visual comparison with a reviewed baseline',
  drivers: ['playwright'],
  unsupported:
    'The macOS accessibility driver does not capture deterministic screenshots for baseline comparison',
};

// Lowercase letters, digits and dashes, for path segments.
export function slug(value: string): string {
  const out = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return out || 'unnamed';
}

// Stable JSON: object keys sorted, so the same environment always hashes
// the same.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

export function environmentId(environment: VisualEnvironment): string {
  return createHash('sha256')
    .update(canonical(visualEnvironmentSchema.parse(environment)))
    .digest('hex')
    .slice(0, 16);
}

export const sha256 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

// Leaf fields of an environment, dotted (browser.version, capture.masks ...).
function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value))
      for (const [path, leaf] of flatten(inner, prefix ? `${prefix}.${key}` : key))
        out.set(path, leaf);
  } else out.set(prefix, Array.isArray(value) ? JSON.stringify(value) : String(value));
  return out;
}

export function environmentDifferences(
  baseline: VisualEnvironment,
  current: VisualEnvironment,
): VisualComparison['incompatible'] {
  const before = flatten(baseline);
  const after = flatten(current);
  const fields = [...new Set([...before.keys(), ...after.keys()])].sort();
  return fields
    .filter((field) => before.get(field) !== after.get(field))
    .map((field) => ({
      field,
      baseline: before.get(field) ?? '(absent)',
      current: after.get(field) ?? '(absent)',
    }));
}

// ---------------------------------------------------------------------------
// The baseline store: <root>/<suite slug>/<journey>/<checkpoint slug>/
// <viewport>/<environment id>.png with a .json beside it.

export const BASELINE_METADATA_VERSION = 1;

export const baselineMetadataSchema = z
  .object({
    version: z.literal(BASELINE_METADATA_VERSION),
    key: visualKeySchema,
    environmentId: z.string().regex(/^[0-9a-f]{16}$/),
    environment: visualEnvironmentSchema,
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    approvedAt: z.iso.datetime(),
    // The run whose capture was approved.
    source: z
      .object({ results: z.string().min(1), attempt: z.number().int().min(1) })
      .strict(),
  })
  .strict();
export type BaselineMetadata = z.infer<typeof baselineMetadataSchema>;

export function baselineDirectory(root: string, key: VisualKey): string {
  return join(
    root,
    slug(key.suite),
    key.journey,
    key.checkpoint.replace(':', '-'),
    key.viewport,
  );
}

export function baselineFiles(
  root: string,
  key: VisualKey,
  id: string,
): { png: string; json: string } {
  const directory = baselineDirectory(root, key);
  return { png: join(directory, `${id}.png`), json: join(directory, `${id}.json`) };
}

const sameKey = (a: VisualKey, b: VisualKey) =>
  a.suite === b.suite &&
  a.journey === b.journey &&
  a.checkpoint === b.checkpoint &&
  a.viewport === b.viewport;

// Every approved baseline of a checkpoint and viewport, newest first. Throws
// on metadata that does not parse or belongs to another key: a corrupt store
// is an audit error, never a missing baseline.
export async function readBaselines(
  root: string,
  key: VisualKey,
): Promise<BaselineMetadata[]> {
  const directory = baselineDirectory(root, key);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw caught;
  }
  const entries: BaselineMetadata[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const parsed = baselineMetadataSchema.safeParse(
      JSON.parse(await readFile(join(directory, name), 'utf8')),
    );
    if (!parsed.success)
      throw new Error(`Invalid baseline metadata ${join(directory, name)}`);
    if (
      !sameKey(parsed.data.key, key) ||
      `${parsed.data.environmentId}.json` !== name
    )
      throw new Error(
        `Baseline metadata ${join(directory, name)} does not belong to ${key.suite}/${key.journey}/${key.checkpoint}/${key.viewport}`,
      );
    entries.push(parsed.data);
  }
  return entries.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
}

// ---------------------------------------------------------------------------
// Image comparison.

const DIFF_COLOR: [number, number, number] = [255, 0, 0];
// Changed pixels that are darker in the current image.
const DIFF_COLOR_DARKER: [number, number, number] = [0, 64, 255];
// Changed pixels are grouped into regions on a grid of this many CSS pixels.
const REGION_CELL = 16;
const MAX_REGIONS = 20;

// Pads an image to width x height with transparent pixels.
function padded(image: PNG, width: number, height: number): Buffer {
  if (image.width === width && image.height === height) return image.data;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < image.height; y++)
    image.data.copy(
      out,
      y * width * 4,
      y * image.width * 4,
      (y + 1) * image.width * 4,
    );
  return out;
}

// Connected groups of grid cells that hold changed pixels.
function regionsOf(
  changed: Uint8Array,
  width: number,
  height: number,
): VisualRegion[] {
  const columns = Math.ceil(width / REGION_CELL);
  const rows = Math.ceil(height / REGION_CELL);
  const cells = new Uint32Array(columns * rows);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (changed[y * width + x])
        cells[
          Math.floor(y / REGION_CELL) * columns + Math.floor(x / REGION_CELL)
        ]!++;
  const seen = new Uint8Array(cells.length);
  const regions: VisualRegion[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let minX = columns;
    let minY = rows;
    let maxX = 0;
    let maxY = 0;
    let diffPixels = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop()!;
      const cx = cell % columns;
      const cy = Math.floor(cell / columns);
      diffPixels += cells[cell]!;
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
          const next = ny * columns + nx;
          if (cells[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
    }
    const x = minX * REGION_CELL;
    const y = minY * REGION_CELL;
    regions.push({
      x,
      y,
      width: Math.min(width, (maxX + 1) * REGION_CELL) - x,
      height: Math.min(height, (maxY + 1) * REGION_CELL) - y,
      diffPixels,
    });
  }
  return regions.sort((a, b) => b.diffPixels - a.diffPixels);
}

export type ImageComparison = {
  pixels: NonNullable<VisualComparison['pixels']>;
  regions: VisualRegion[];
  regionCount: number;
  // Changed pixels over a faded current image (PNG).
  diff: Buffer;
  // Over the tolerance.
  mismatch: boolean;
};

export function compareImages(
  baselinePng: Buffer,
  currentPng: Buffer,
  tolerance: VisualTolerance,
): ImageComparison {
  const baseline = PNG.sync.read(baselinePng);
  const current = PNG.sync.read(currentPng);
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const sizeChanged =
    baseline.width !== current.width || baseline.height !== current.height;
  const output = new PNG({ width, height });
  // Faded current image underneath, changed pixels on top.
  const diffPixels = pixelmatch(
    padded(baseline, width, height),
    padded(current, width, height),
    output.data,
    width,
    height,
    {
      threshold: tolerance.threshold,
      includeAA: false,
      alpha: 0.1,
      diffColor: DIFF_COLOR,
      diffColorAlt: DIFF_COLOR_DARKER,
    },
  );
  // pixelmatch paints unchanged pixels grey (r = g = b) and anti-aliasing
  // yellow, so exactly the two diff colours mark counted changes.
  const changed = new Uint8Array(width * height);
  for (let index = 0, pos = 0; index < changed.length; index++, pos += 4) {
    const r = output.data[pos]!;
    const g = output.data[pos + 1]!;
    const b = output.data[pos + 2]!;
    if (
      (r === DIFF_COLOR[0] && g === DIFF_COLOR[1] && b === DIFF_COLOR[2]) ||
      (r === DIFF_COLOR_DARKER[0] &&
        g === DIFF_COLOR_DARKER[1] &&
        b === DIFF_COLOR_DARKER[2])
    )
      changed[index] = 1;
  }
  const regions = diffPixels ? regionsOf(changed, width, height) : [];
  const total = width * height;
  const ratio = total ? diffPixels / total : 0;
  return {
    pixels: { diff: diffPixels, total, ratio, sizeChanged },
    regions: regions.slice(0, MAX_REGIONS),
    regionCount: regions.length,
    diff: PNG.sync.write(output),
    mismatch:
      sizeChanged ||
      diffPixels > tolerance.maxDiffPixels ||
      ratio > tolerance.maxDiffRatio,
  };
}

export function imageOf(file: string, png: Buffer): VisualImage {
  const image = PNG.sync.read(png);
  return { file, width: image.width, height: image.height, sha256: sha256(png) };
}

// ---------------------------------------------------------------------------
// One checkpoint's comparison, from a settled capture (or none) to the audit
// output. Writes the current, baseline copy and diff images into the run
// directory; never into the baseline store.

export type VisualCompareInput = {
  key: VisualKey;
  environment: VisualEnvironment;
  settings: VisualBaselineConfig;
  // The settled capture, or null when the page never settled.
  current: Buffer | null;
  captures: number;
  masks: VisualComparison['masks'];
  // Null when no baseline directory was supplied.
  baselines: string | null;
  // Run directory for the evidence images.
  directory: string;
  // Readiness notes from the capture (network not idle ...).
  limitations: string[];
};

const LIMITATIONS = [
  'Compares pixels with an approved baseline from the same rendering environment; it does not judge whether the approved image was right',
  'Masked regions are painted over in both images and are not compared',
];

const keyText = (key: VisualKey) =>
  `${key.suite} / ${key.journey} / ${key.checkpoint} / ${key.viewport}`;

const approveHint = (key: VisualKey) =>
  `review the current image, then run: npm run baseline -- approve --run <run directory> --baselines <directory> --journey ${key.journey} --viewport ${key.viewport} --checkpoint ${key.checkpoint}`;

export async function compareCheckpoint(
  input: VisualCompareInput,
): Promise<AuditOutput & { visual: VisualComparison }> {
  const { key, environment, settings, directory } = input;
  const id = environmentId(environment);
  const stem = join(
    directory,
    `visual-${key.checkpoint.replace(':', '-')}`,
  );
  const tolerance: VisualTolerance = {
    threshold: settings.threshold,
    maxDiffPixels: settings.maxDiffPixels,
    maxDiffRatio: settings.maxDiffRatio,
  };
  let current: VisualImage | null = null;
  if (input.current) {
    await writeFile(`${stem}-current.png`, input.current, { mode: 0o600 });
    current = imageOf(`${stem}-current.png`, input.current);
  }
  const visual: VisualComparison = {
    key,
    environmentId: id,
    status: 'missing',
    environment,
    current,
    baseline: null,
    diff: null,
    incompatible: [],
    pixels: null,
    regions: [],
    regionCount: 0,
    tolerance,
    masks: input.masks,
    captures: input.captures,
  };
  const limitations = [...LIMITATIONS, ...input.limitations];
  const unmatched = input.masks.filter((mask) => !mask.matched);
  if (unmatched.length)
    limitations.push(
      `Mask selector(s) matched nothing in this capture: ${unmatched.map((mask) => mask.selector).join(', ')}`,
    );
  const base = {
    observations: 1,
    analyzer: { name: 'pixelmatch', version: PIXELMATCH_VERSION },
    limitations,
    exemptions: [],
    visual,
  };
  if (!input.current)
    return {
      ...base,
      visual: { ...visual, status: 'unstable' },
      complete: false,
      detail: `unstable: the page did not render the same image twice in ${input.captures} captures; mask the changing region or wait for it in the journey`,
      findings: [],
    };
  if (input.baselines === null)
    return {
      ...base,
      complete: false,
      detail: `missing: no baseline directory was supplied (--baselines DIR), so ${keyText(key)} was captured but not compared; ${approveHint(key)}`,
      findings: [],
    };
  const approved = await readBaselines(input.baselines, key);
  const match = approved.find((entry) => entry.environmentId === id);
  if (!match) {
    if (!approved.length)
      return {
        ...base,
        complete: false,
        detail: `missing: no approved baseline for ${keyText(key)}; ${approveHint(key)}`,
        findings: [],
      };
    const incompatible = environmentDifferences(approved[0]!.environment, environment);
    return {
      ...base,
      visual: { ...visual, status: 'incompatible', incompatible },
      complete: false,
      detail: `incompatible: ${approved.length} approved baseline(s) for ${keyText(key)}, none from this rendering environment (differs in ${incompatible.map((entry) => entry.field).join(', ')}); not compared`,
      findings: [],
    };
  }
  const files = baselineFiles(input.baselines, key, id);
  const baselinePng = await readFile(files.png);
  if (sha256(baselinePng) !== match.image.sha256)
    throw new Error(
      `Baseline image ${files.png} does not match its approved checksum; re-approve it`,
    );
  await copyFile(files.png, `${stem}-baseline.png`);
  const compared = compareImages(baselinePng, input.current, tolerance);
  await writeFile(`${stem}-diff.png`, compared.diff, { mode: 0o600 });
  const result: VisualComparison = {
    ...visual,
    status: compared.mismatch ? 'mismatch' : 'match',
    baseline: {
      ...imageOf(`${stem}-baseline.png`, baselinePng),
      approvedAt: match.approvedAt,
    },
    diff: `${stem}-diff.png`,
    pixels: compared.pixels,
    regions: compared.regions,
    regionCount: compared.regionCount,
  };
  const percent = (compared.pixels.ratio * 100).toFixed(3);
  const findings: AuditOutputFinding[] = compared.mismatch
    ? [
        {
          ruleId: 'visual.mismatch',
          severity: settings.severity,
          certainty: 'violation',
          description: compared.pixels.sizeChanged
            ? `The capture is ${current!.width}x${current!.height} px, the approved baseline ${result.baseline!.width}x${result.baseline!.height} px; ${compared.pixels.diff} pixels (${percent}%) differ, the uncovered area included`
            : `${compared.pixels.diff} of ${compared.pixels.total} pixels (${percent}%) differ from the approved baseline in ${compared.regionCount} region(s); tolerance ${tolerance.maxDiffPixels} pixels and ${(tolerance.maxDiffRatio * 100).toFixed(3)}%`,
          helpUrl: null,
          tags: ['visual'],
          nodeCount: compared.regionCount,
          targets: compared.regions.map((region) => ({
            description: `Region at ${region.x},${region.y}, ${region.width}x${region.height} px: ${region.diffPixels} changed pixels`,
            selector: null,
          })),
          files: [`${stem}-current.png`, `${stem}-baseline.png`, `${stem}-diff.png`],
        },
      ]
    : [];
  return {
    ...base,
    visual: result,
    complete: true,
    detail: compared.mismatch
      ? `mismatch: ${compared.pixels.diff} pixels differ`
      : compared.pixels.diff
        ? `match: ${compared.pixels.diff} pixels differ, within tolerance`
        : 'match: identical to the approved baseline',
    findings,
  };
}
