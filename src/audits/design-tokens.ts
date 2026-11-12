// Design token conformance (the `design.tokens` audit): the token-set format
// a suite supplies, its loader (a file relative to the suite, in the native
// format or the W3C Design Tokens Community Group format), colour and length
// matching, and the mapping of a measurement onto the audit contract.
// Measurement runs in the page (design-detect.ts) and is driven by a browser
// driver (drivers/playwright-design.ts); nothing here depends on a browser.
//
// What it decides is objective: whether a computed CSS value is one of the
// suite's tokens, within a stated tolerance. It does not compare the page with
// design files, judge similarity or aesthetics, or guess intent; those are
// not attempted, and every run says so in its limitations.
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Suite } from '../contracts.js';
import type { AuditConfig } from './config.js';
import {
  severitySchema,
  type AuditExemption,
  type AuditOutput,
  type AuditOutputFinding,
} from './contract.js';
import type { AuditDefinition } from './registry.js';

// ---- Rules ----

export const DESIGN_RULES = [
  'color',
  'font-family',
  'font-size',
  'spacing',
  'radius',
] as const;
export const designRuleSchema = z.enum(DESIGN_RULES);
export type DesignRule = z.infer<typeof designRuleSchema>;

// The token-set category each rule compares against.
export const RULE_CATEGORY = {
  color: 'color',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  spacing: 'spacing',
  radius: 'radius',
} as const satisfies Record<DesignRule, string>;
type Category = (typeof RULE_CATEGORY)[DesignRule];

// ---- Colours ----

export type RGBA = [number, number, number, number];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = '\\s*(-?\\d+(?:\\.\\d+)?|-?\\.\\d+)\\s*';
const RGB = new RegExp(
  `^rgba?\\(${NUMBER},${NUMBER},${NUMBER}(?:,${NUMBER})?\\)$`,
  'i',
);

// Hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or legacy rgb()/rgba(), as computed
// styles report sRGB colours. Channels 0-255, alpha 0-1; null when invalid.
export function parseColor(value: string): RGBA | null {
  const text = value.trim();
  const hex = HEX.exec(text)?.[1];
  if (hex) {
    const digits =
      hex.length <= 4
        ? hex
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : hex;
    const channel = (index: number) =>
      parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    return [
      channel(0),
      channel(1),
      channel(2),
      digits.length === 8 ? channel(3) / 255 : 1,
    ];
  }
  const rgb = RGB.exec(text);
  if (!rgb) return null;
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if ([r, g, b].some((channel) => channel < 0 || channel > 255)) return null;
  if (a < 0 || a > 1) return null;
  return [r, g, b, a];
}

const hex2 = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
export const colorHex = ([r, g, b, a]: RGBA): string =>
  `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;

type Lab = [number, number, number];

// sRGB (D65) to CIELAB.
export function srgbToLab([r, g, b]: RGBA | [number, number, number]): Lab {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

// CIEDE2000 colour difference (Sharma, Wu and Dalal 2005). About 1 is a just
// noticeable difference.
export function deltaE2000Lab([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) =>
    a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0)
    hpm =
      Math.abs(h1p - h2p) <= 180
        ? (h1p + h2p) / 2
        : (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  const T =
    1 -
    0.17 * Math.cos(rad(hpm - 30)) +
    0.24 * Math.cos(rad(2 * hpm)) +
    0.32 * Math.cos(rad(3 * hpm + 6)) -
    0.2 * Math.cos(rad(4 * hpm - 63));
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Cpm7 = Cpm ** 7;
  const Rc = 2 * Math.sqrt(Cpm7 / (Cpm7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 +
      (dCp / Sc) ** 2 +
      (dHp / Sh) ** 2 +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export const deltaE2000 = (a: RGBA, b: RGBA): number =>
  deltaE2000Lab(srgbToLab(a), srgbToLab(b));

// ---- The token set ----

const LENGTH = /^(\d+(?:\.\d+)?|\.\d+)(px|rem)$/;
const tokenName = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^{}\s][^{}]*$/, 'Token names cannot contain braces');
const colorValue = z
  .string()
  .max(60)
  .refine(
    (value) => parseColor(value) !== null,
    'Colours are hex (#rrggbb, #rgb, #rrggbbaa) or rgb()/rgba()',
  );
// CSS px as a number, or a px/rem string ("16px", "1rem"). rem tokens are
// converted with the page's root font size.
const lengthValue = z.union([
  z.number().min(0).max(10000),
  z.string().regex(LENGTH, 'Lengths are numbers (px) or "<n>px" / "<n>rem"'),
]);
const fontFamilyValue = z.union([
  z.string().min(1).max(300),
  z.array(z.string().min(1).max(100)).min(1).max(20),
]);
const category = <T extends z.ZodType>(value: T) =>
  z
    .record(tokenName, value)
    .refine(
      (tokens) => Object.keys(tokens).length >= 1,
      'A token category needs at least one token (leave it out instead)',
    )
    .refine(
      (tokens) => Object.keys(tokens).length <= 500,
      'At most 500 tokens per category',
    )
    .optional();

// The native format. Every category is optional, but a set needs at least one.
export const designTokenSetSchema = z
  .object({
    version: z.literal(1),
    // Shown in results; the loader sets it to the file path when absent.
    name: z.string().min(1).max(200).optional(),
    color: category(colorValue),
    fontFamily: category(fontFamilyValue),
    fontSize: category(lengthValue),
    spacing: category(lengthValue),
    radius: category(lengthValue),
    // Tokens of types the audit does not check, as "path (type)", set by the
    // W3C format loader so they are listed, never silently dropped.
    ignored: z.array(z.string().min(1).max(300)).max(1000).optional(),
  })
  .strict()
  .refine(
    (set) =>
      (['color', 'fontFamily', 'fontSize', 'spacing', 'radius'] as const).some(
        (key) => set[key] !== undefined,
      ),
    'A token set needs at least one of color, fontFamily, fontSize, spacing, radius',
  );
export type DesignTokenSet = z.infer<typeof designTokenSetSchema>;

// ---- W3C Design Tokens Community Group format ----

type Entry = { type: string | undefined; value: unknown };
const ALIAS = /^\{([^{}]+)\}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Dimension tokens carry no purpose in the format, so their group names it:
// the first path segment, or the first two joined (font.size).
const DIMENSION_GROUPS: Record<string, 'fontSize' | 'spacing' | 'radius'> = {
  fontsize: 'fontSize',
  fontsizes: 'fontSize',
  textsize: 'fontSize',
  spacing: 'spacing',
  spacings: 'spacing',
  space: 'spacing',
  spaces: 'spacing',
  radius: 'radius',
  radii: 'radius',
  borderradius: 'radius',
  borderradii: 'radius',
};
const groupKey = (segment: string) =>
  segment.toLowerCase().replace(/[^a-z0-9]/g, '');

function dimensionGroup(
  path: string,
): 'fontSize' | 'spacing' | 'radius' | null {
  const [first = '', second = ''] = path.split('.').map(groupKey);
  return DIMENSION_GROUPS[first] ?? DIMENSION_GROUPS[first + second] ?? null;
}

function dtcgColor(value: unknown): string | null {
  if (typeof value === 'string') return parseColor(value) ? value : null;
  if (!plain(value)) return null;
  if (typeof value.hex === 'string' && parseColor(value.hex)) {
    const alpha = typeof value.alpha === 'number' ? value.alpha : 1;
    const rgba = parseColor(value.hex)!;
    return colorHex([rgba[0], rgba[1], rgba[2], alpha]);
  }
  const components = value.components;
  if (
    value.colorSpace === 'srgb' &&
    Array.isArray(components) &&
    components.length === 3 &&
    components.every((c) => typeof c === 'number' && c >= 0 && c <= 1)
  ) {
    const alpha = typeof value.alpha === 'number' ? value.alpha : 1;
    const [r, g, b] = (components as number[]).map((c) => c * 255) as [
      number,
      number,
      number,
    ];
    return colorHex([r, g, b, alpha]);
  }
  return null;
}

function dtcgLength(value: unknown): string | null {
  if (typeof value === 'string') return LENGTH.test(value) ? value : null;
  if (
    plain(value) &&
    typeof value.value === 'number' &&
    value.value >= 0 &&
    (value.unit === 'px' || value.unit === 'rem')
  )
    return `${value.value}${value.unit}`;
  return null;
}

// Converts a DTCG document (nested groups, inherited $type, {path} aliases)
// to the native set. Unsupported types and values are listed in `ignored`.
function fromDTCG(raw: Record<string, unknown>, name: string): unknown {
  const entries = new Map<string, Entry>();
  const walk = (
    node: Record<string, unknown>,
    path: string[],
    inherited: string | undefined,
  ) => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !plain(child)) continue;
      const type = typeof child.$type === 'string' ? child.$type : inherited;
      const childPath = [...path, key];
      if ('$value' in child)
        entries.set(childPath.join('.'), { type, value: child.$value });
      else walk(child, childPath, type);
    }
  };
  walk(raw, [], typeof raw.$type === 'string' ? raw.$type : undefined);
  const resolveEntry = (path: string, seen: string[] = []): Entry => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Unknown alias {${path}}`);
    const alias =
      typeof entry.value === 'string' ? ALIAS.exec(entry.value)?.[1] : null;
    if (!alias) return entry;
    if (seen.includes(alias) || seen.length > 20)
      throw new Error(`Alias cycle: ${[...seen, path, alias].join(' -> ')}`);
    const target = resolveEntry(alias, [...seen, path]);
    return { type: entry.type ?? target.type, value: target.value };
  };
  const set: Record<Category, Record<string, string>> = {
    color: {},
    fontFamily: {},
    fontSize: {},
    spacing: {},
    radius: {},
  };
  const ignored: string[] = [];
  for (const path of entries.keys()) {
    const { type, value } = resolveEntry(path);
    if (type === 'color') {
      const color = dtcgColor(value);
      if (color) set.color[path] = color;
      else ignored.push(`${path} (unsupported colour value)`);
    } else if (type === 'fontFamily') {
      if (typeof value === 'string' && value.trim())
        set.fontFamily[path] = value;
      else if (
        Array.isArray(value) &&
        value.length &&
        value.every((family) => typeof family === 'string' && family.trim())
      )
        set.fontFamily[path] = value.join(', ');
      else ignored.push(`${path} (unsupported fontFamily value)`);
    } else if (type === 'dimension') {
      const group = dimensionGroup(path);
      const length = dtcgLength(value);
      if (!group)
        ignored.push(
          `${path} (dimension outside a fontSize, spacing or radius group)`,
        );
      else if (!length) ignored.push(`${path} (unsupported dimension value)`);
      else set[group][path] = length;
    } else ignored.push(`${path} (${type ?? 'no $type'})`);
  }
  const used = Object.entries(set).filter(
    ([, tokens]) => Object.keys(tokens).length,
  );
  if (!used.length)
    throw new Error(
      `${name} contains no design tokens this audit checks (color, fontFamily, or dimension tokens in fontSize, spacing or radius groups)`,
    );
  return {
    version: 1,
    name,
    ...Object.fromEntries(used),
    ...(ignored.length ? { ignored: ignored.slice(0, 1000) } : {}),
  };
}

// A token file's content: the native format (with "version": 1) or a DTCG
// document. `name` names the set when the file does not.
export function parseTokenFile(raw: unknown, name: string): DesignTokenSet {
  if (!plain(raw)) throw new Error(`${name} is not a JSON object`);
  if ('version' in raw) return designTokenSetSchema.parse({ name, ...raw });
  return designTokenSetSchema.parse(fromDTCG(raw, name));
}

const MAX_TOKEN_FILE_BYTES = 2 * 1024 * 1024;

async function readTokenFile(
  path: string,
  name: string,
): Promise<DesignTokenSet> {
  try {
    if ((await stat(path)).size > MAX_TOKEN_FILE_BYTES)
      throw new Error(`larger than ${MAX_TOKEN_FILE_BYTES} bytes`);
    return parseTokenFile(JSON.parse(await readFile(path, 'utf8')), name);
  } catch (caught) {
    const message =
      caught instanceof z.ZodError
        ? z.prettifyError(caught)
        : caught instanceof Error
          ? caught.message
          : String(caught);
    throw new Error(`Design token file ${path}: ${message}`);
  }
}

// Resolves every design.tokens entry whose `tokens` is a file path, relative
// to the suite file, into its parsed token set. Returns a new suite; the
// given one is unchanged. The CLI and the benchmark call it after parsing a
// suite; programmatic runs call it themselves (or give tokens inline).
export async function loadDesignTokens(
  suite: Suite,
  suitePath: string,
): Promise<Suite> {
  const checks = await Promise.all(
    suite.audits.checks.map(async (check) =>
      check.id === 'design.tokens' && typeof check.tokens === 'string'
        ? {
            ...check,
            tokens: await readTokenFile(
              resolve(dirname(resolve(suitePath)), check.tokens),
              check.tokens,
            ),
          }
        : check,
    ),
  );
  return { ...suite, audits: { ...suite.audits, checks } };
}

// ---- Configuration ----

const cssSelectors = z.array(z.string().min(1).max(200)).max(20).default([]);

export const designExceptionSchema = z
  .object({
    // Matched against the measured element or one of its ancestors.
    selector: z.string().min(1).max(500),
    reason: z.string().min(1).max(500),
    // The rules it exempts; all of them when omitted.
    rules: z.array(designRuleSchema).min(1).max(5).optional(),
  })
  .strict();
export type DesignException = z.infer<typeof designExceptionSchema>;

export const DEFAULT_DESIGN_TOLERANCE = {
  colorDeltaE: 1,
  alpha: 0.02,
  lengthPx: 0.5,
};

// Fields of the design.tokens audit entry (spread into src/audits/config.ts).
export const designTokensConfigShape = {
  // A token file path, relative to the suite file, or an inline native set.
  tokens: z.union([z.string().min(1).max(500), designTokenSetSchema]),
  // CSS selectors of the regions to measure; empty measures the body. A
  // selector that matches nothing is an audit error, never a clean region.
  include: cssSelectors,
  // Regions left out, such as a third-party widget.
  exclude: cssSelectors,
  // The rules to run; by default every rule whose category the set defines.
  rules: z
    .array(designRuleSchema)
    .min(1)
    .max(DESIGN_RULES.length)
    .refine(
      (rules) => new Set(rules).size === rules.length,
      'Rules must be unique',
    )
    .optional(),
  tolerance: z
    .object({
      // CIEDE2000 distance within which a colour is the token.
      colorDeltaE: z
        .number()
        .min(0)
        .max(50)
        .default(DEFAULT_DESIGN_TOLERANCE.colorDeltaE),
      // Alpha difference within which a colour is the token.
      alpha: z.number().min(0).max(1).default(DEFAULT_DESIGN_TOLERANCE.alpha),
      // CSS px within which a font size, spacing or radius is the token.
      lengthPx: z
        .number()
        .min(0)
        .max(16)
        .default(DEFAULT_DESIGN_TOLERANCE.lengthPx),
    })
    .strict()
    .prefault({}),
  // Severity of an off-token finding, against audits.failOn.
  severity: severitySchema.default('moderate'),
  exceptions: z.array(designExceptionSchema).max(50).default([]),
  // Elements measured at most; past it the run is incomplete.
  maxElements: z.number().int().min(1).max(20000).default(3000),
};

export type DesignTokensConfig = Extract<AuditConfig, { id: 'design.tokens' }>;

export const designTokensAudit: AuditDefinition<DesignTokensConfig> = {
  id: 'design.tokens',
  source: 'builtin',
  title: 'Design token conformance (computed styles)',
  drivers: ['playwright'],
  unsupported:
    'design.tokens reads computed CSS styles of web pages; the macOS accessibility driver exposes no styles',
};

// The parsed set, or an error saying how a file path is loaded.
export function resolvedTokens(config: DesignTokensConfig): DesignTokenSet {
  if (typeof config.tokens === 'string')
    throw new Error(
      `design.tokens: the token file "${config.tokens}" was not loaded. The CLI resolves it relative to the suite file; programmatic runs call loadDesignTokens(suite, suitePath) first or give the tokens inline`,
    );
  return config.tokens;
}

// The rules a run checks: the configured ones (each needs its category), or
// every rule whose category the set defines.
export function activeRules(
  config: DesignTokensConfig,
  tokens: DesignTokenSet,
): DesignRule[] {
  const has = (rule: DesignRule) => tokens[RULE_CATEGORY[rule]] !== undefined;
  if (!config.rules) return DESIGN_RULES.filter(has);
  for (const rule of config.rules)
    if (!has(rule))
      throw new Error(
        `design.tokens: rule ${rule} is selected but the token set has no ${rule} tokens (${RULE_CATEGORY[rule]})`,
      );
  return config.rules;
}

// ---- The measurement (raw page output, parsed at the driver boundary) ----

export const designSampleSchema = z
  .object({
    // Index into nodes.
    node: z.number().int().nonnegative(),
    rule: designRuleSchema,
    // The CSS property group: color, background-color, border-color,
    // font-family, font-size, margin, padding, gap, border-radius.
    property: z.string().min(1).max(40),
    // The computed value as the page reported it.
    value: z.string().max(500),
    // Lengths in CSS px (signed for margins); null for colours and families.
    px: z.number().nullable(),
    // sRGB channels 0-255 and alpha 0-1; null for non-colours.
    rgba: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  })
  .strict();
export type DesignSample = z.infer<typeof designSampleSchema>;

export const designMeasurementSchema = z
  .object({
    url: z.string(),
    rootFontSizePx: z.number().positive(),
    // Whether the browser has CSS Typed OM (computedStyleMap), which tells
    // auto and percentage margins and paddings apart from lengths.
    typedOM: z.boolean(),
    // Rendered elements measured.
    elements: z.number().int().nonnegative(),
    truncated: z.boolean(),
    nodes: z
      .array(
        z
          .object({
            selector: z.string().min(1),
            description: z.string().min(1),
            // Indices of the configured exceptions matching it or an ancestor.
            exceptions: z.array(z.number().int().nonnegative()),
          })
          .strict(),
      )
      .max(20000),
    samples: z.array(designSampleSchema).max(400000),
    // Values not compared: percentages and calc() with percentages
    // (relative) and auto margins.
    skipped: z
      .object({
        relative: z.number().int().nonnegative(),
        auto: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type DesignMeasurement = z.infer<typeof designMeasurementSchema>;

// ---- Evaluation ----

type Nearest = { name: string; display: string; distance: string } | null;

export type DesignValueGroup = {
  rule: DesignRule;
  // Normalized value (hex colour, px length, primary family).
  value: string;
  properties: string[];
  nodes: number[];
  nearest: Nearest;
};

export type DesignEvaluation = {
  tokens: DesignTokenSet;
  rules: DesignRule[];
  measurement: DesignMeasurement;
  compared: number;
  offToken: DesignValueGroup[];
  exempted: (DesignValueGroup & { exception: number })[];
  negativeMargins: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const px = (value: number) => `${round1(value)}px`;

const lengthPx = (value: string | number, rootPx: number): number => {
  if (typeof value === 'number') return value;
  const [, amount, unit] = LENGTH.exec(value)!;
  return Number(amount) * (unit === 'rem' ? rootPx : 1);
};

const unquote = (family: string) =>
  family
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
export const primaryFamily = (stack: string | readonly string[]): string =>
  unquote(
    (typeof stack === 'string' ? stack : stack.join(',')).split(',')[0] ?? '',
  );

type Matcher = (sample: DesignSample) => {
  match: boolean;
  nearest: Nearest;
  key: string;
};

function matcher(
  rule: DesignRule,
  tokens: DesignTokenSet,
  config: DesignTokensConfig,
  rootPx: number,
): Matcher {
  const { tolerance } = config;
  if (rule === 'color') {
    const palette = Object.entries(tokens.color ?? {}).map(([name, value]) => ({
      name,
      rgba: parseColor(value)!,
    }));
    return (sample) => {
      const rgba = sample.rgba!;
      let best: { name: string; rgba: RGBA; dE: number; dA: number } | null =
        null;
      for (const token of palette) {
        const dE = deltaE2000(rgba, token.rgba);
        const dA = Math.abs(rgba[3] - token.rgba[3]);
        if (!best || dE + dA * 100 < best.dE + best.dA * 100)
          best = { ...token, dE, dA };
      }
      const match =
        best !== null &&
        palette.some(
          (token) =>
            deltaE2000(rgba, token.rgba) <= tolerance.colorDeltaE &&
            Math.abs(rgba[3] - token.rgba[3]) <= tolerance.alpha,
        );
      return {
        match,
        key: colorHex(rgba),
        nearest: best && {
          name: best.name,
          display: colorHex(best.rgba),
          distance: `ΔE2000 ${round1(best.dE)}${best.dA > tolerance.alpha ? `, alpha ${round1(rgba[3] * 100) / 100} vs ${round1(best.rgba[3] * 100) / 100}` : ''}`,
        },
      };
    };
  }
  if (rule === 'font-family') {
    const families = Object.entries(tokens.fontFamily ?? {}).map(
      ([name, value]) => ({
        name,
        primary: primaryFamily(value),
      }),
    );
    return (sample) => {
      const primary = primaryFamily(sample.value);
      return {
        match: families.some(
          (family) => family.primary.toLowerCase() === primary.toLowerCase(),
        ),
        key: primary,
        nearest: null,
      };
    };
  }
  const values = Object.entries(
    tokens[RULE_CATEGORY[rule] as 'fontSize' | 'spacing' | 'radius'] ?? {},
  ).map(([name, value]) => ({
    name,
    px: lengthPx(value, rootPx),
    display:
      typeof value === 'string' && value.endsWith('rem')
        ? `${value} = ${px(lengthPx(value, rootPx))}`
        : px(lengthPx(value, rootPx)),
  }));
  return (sample) => {
    // Negative margins are compared by magnitude.
    const measured = Math.abs(sample.px!);
    let best: (typeof values)[number] | null = null;
    for (const token of values)
      if (!best || Math.abs(token.px - measured) < Math.abs(best.px - measured))
        best = token;
    const diff = best ? Math.abs(best.px - measured) : Infinity;
    return {
      match: diff <= tolerance.lengthPx,
      key: px(sample.px!),
      nearest: best && {
        name: best.name,
        display: best.display,
        distance: `${px(diff)} away`,
      },
    };
  };
}

// Compares every sample with the token set and groups off-token values by
// rule and value; values under a configured exception are grouped apart.
export function evaluateDesign(
  measurement: DesignMeasurement,
  config: DesignTokensConfig,
  tokens: DesignTokenSet,
  rules: DesignRule[],
): DesignEvaluation {
  const matchers = new Map(
    rules.map((rule) => [
      rule,
      matcher(rule, tokens, config, measurement.rootFontSizePx),
    ]),
  );
  const off = new Map<string, DesignValueGroup>();
  const exempt = new Map<string, DesignValueGroup & { exception: number }>();
  let compared = 0;
  let negativeMargins = 0;
  for (const sample of measurement.samples) {
    const match = matchers.get(sample.rule);
    if (!match) continue;
    compared++;
    if (sample.property === 'margin' && (sample.px ?? 0) < 0) negativeMargins++;
    const result = match(sample);
    if (result.match) continue;
    const node = measurement.nodes[sample.node];
    const exception = node?.exceptions.find((index) => {
      const entry = config.exceptions[index];
      return entry && (!entry.rules || entry.rules.includes(sample.rule));
    });
    const key = `${sample.rule}|${result.key}`;
    const groups = exception === undefined ? off : exempt;
    const groupKey = exception === undefined ? key : `${exception}|${key}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        rule: sample.rule,
        value: result.key,
        properties: [],
        nodes: [],
        nearest: result.nearest,
        ...(exception === undefined ? {} : { exception }),
      } as DesignValueGroup & { exception: number };
      groups.set(groupKey, group);
    }
    if (!group.properties.includes(sample.property))
      group.properties.push(sample.property);
    if (!group.nodes.includes(sample.node)) group.nodes.push(sample.node);
  }
  const order = (a: DesignValueGroup, b: DesignValueGroup) =>
    DESIGN_RULES.indexOf(a.rule) - DESIGN_RULES.indexOf(b.rule) ||
    b.nodes.length - a.nodes.length ||
    a.value.localeCompare(b.value);
  return {
    tokens,
    rules,
    measurement,
    compared,
    offToken: [...off.values()].sort(order),
    exempted: [...exempt.values()].sort(order),
    negativeMargins,
  };
}

// ---- Mapping onto the audit contract ----

// Read on every run, so a result cannot be read as more than it measured.
export const DESIGN_TOKEN_LIMITATIONS = [
  "Compares computed CSS values with the suite's design tokens only. It does not compare the page with design files or mockups (Figma, Sketch), judge visual similarity, or assess aesthetics; for reviewed screenshots use visual.baseline.",
  'font-family compares the primary declared family; whether that font loaded and rendered (rather than a fallback) is not checked.',
  'Not checked: pseudo-elements (::before, ::after, ::placeholder), SVG content, gradients and background images, shadows, outlines, line height, letter spacing and font weight.',
  'Only the audited state is measured: hover, focus, active and other interaction states are not.',
  'Closed shadow roots and frames are not measured.',
] as const;

const PROPERTY_LABEL: Record<string, string> = { color: 'text color' };
const label = (property: string) => PROPERTY_LABEL[property] ?? property;

const MAX_FINDINGS = 200;
const MAX_EXEMPTIONS = 200;
const MAX_TARGETS = 10;

function groupWording(group: DesignValueGroup, display: string): string {
  const properties = group.properties.map(label).join(', ');
  const subject =
    group.rule === 'color' ||
    group.rule === 'font-family' ||
    group.rule === 'font-size'
      ? `${properties} ${display}`
      : `${group.rule} ${display} (${properties})`;
  return subject;
}

function nearestWording(
  group: DesignValueGroup,
  tokens: DesignTokenSet,
): string {
  if (group.rule === 'font-family')
    return `allowed: ${Object.entries(tokens.fontFamily ?? {})
      .map(([name, value]) => `${name} (${primaryFamily(value)})`)
      .join(', ')}`;
  return group.nearest
    ? `nearest token ${group.nearest.name} (${group.nearest.display}), ${group.nearest.distance}`
    : 'no token to compare with';
}

export function designAuditOutput(
  evaluation: DesignEvaluation,
  config: DesignTokensConfig,
  options: { files: string[] },
): AuditOutput {
  const { measurement, tokens, rules } = evaluation;
  const elements = (count: number) =>
    `${count} element${count === 1 ? '' : 's'}`;
  const findings: AuditOutputFinding[] = evaluation.offToken
    .slice(0, MAX_FINDINGS)
    .map((group) => {
      const subject = groupWording(group, group.value);
      const nearest = nearestWording(group, tokens);
      return {
        ruleId: group.rule,
        severity: config.severity,
        certainty: 'violation',
        description: `Off-token ${subject} on ${elements(group.nodes.length)}; ${nearest}`,
        helpUrl: null,
        tags: ['design-tokens', `token-category:${RULE_CATEGORY[group.rule]}`],
        nodeCount: group.nodes.length,
        targets: group.nodes.slice(0, MAX_TARGETS).map((index) => {
          const node = measurement.nodes[index]!;
          return {
            description: node.description,
            selector: node.selector,
            reason: `${subject}; ${nearest}`.slice(0, 2000),
            snippet: null,
          };
        }),
        files: options.files,
      };
    });
  const exemptions: AuditExemption[] = evaluation.exempted
    .slice(0, MAX_EXEMPTIONS)
    .map((group) => {
      const exception = config.exceptions[group.exception]!;
      const node = measurement.nodes[group.nodes[0]!]!;
      return {
        ruleId: group.rule,
        target: {
          description: node.description,
          selector: node.selector,
          reason:
            `${groupWording(group, group.value)} on ${elements(group.nodes.length)}`.slice(
              0,
              2000,
            ),
          snippet: null,
        },
        reason:
          `${exception.reason} (exception #${group.exception}: ${exception.selector})`.slice(
            0,
            2000,
          ),
      };
    });
  const limitations: string[] = [...DESIGN_TOKEN_LIMITATIONS];
  const t = config.tolerance;
  limitations.push(
    `Token set "${tokens.name ?? 'inline'}"; tolerance: CIEDE2000 ≤ ${t.colorDeltaE} and alpha ≤ ${t.alpha} for colours, ≤ ${t.lengthPx}px for lengths. Zero margins, paddings, gaps and radii are always on token; rem tokens use the page's root font size (${measurement.rootFontSizePx}px).`,
  );
  const unchecked = DESIGN_RULES.filter((rule) => !rules.includes(rule));
  if (unchecked.length)
    limitations.push(
      `Not checked: ${unchecked
        .map((rule) =>
          tokens[RULE_CATEGORY[rule]] === undefined
            ? `${rule} (no ${RULE_CATEGORY[rule]} tokens in the set)`
            : `${rule} (not selected)`,
        )
        .join(', ')}`,
    );
  if (config.include.length)
    limitations.push(
      `Only the configured regions were measured: ${config.include.join(', ')}`,
    );
  if (config.exclude.length)
    limitations.push(
      `Excluded regions were not measured: ${config.exclude.join(', ')}`,
    );
  const { relative, auto } = measurement.skipped;
  if (relative)
    limitations.push(
      `${relative} relative value(s) (percentages, calc() with percentages) were not compared with the token scale`,
    );
  if (auto) limitations.push(`${auto} auto margin(s) were not compared`);
  if (evaluation.negativeMargins)
    limitations.push(
      `${evaluation.negativeMargins} negative margin(s) were compared by magnitude`,
    );
  const used = new Set(measurement.nodes.flatMap((node) => node.exceptions));
  config.exceptions.forEach((exception, index) => {
    if (!used.has(index))
      limitations.push(
        `Exception #${index} (${exception.selector}) matched no measured element`,
      );
  });
  if (tokens.ignored?.length)
    limitations.push(
      `${tokens.ignored.length} token(s) in the set are of types this audit does not check: ${tokens.ignored.slice(0, 5).join(', ')}${tokens.ignored.length > 5 ? ' ...' : ''}`,
    );
  if (evaluation.offToken.length > MAX_FINDINGS)
    limitations.push(
      `${evaluation.offToken.length - MAX_FINDINGS} more off-token value(s) are listed only in the evidence file`,
    );
  if (evaluation.exempted.length > MAX_EXEMPTIONS)
    limitations.push(
      `${evaluation.exempted.length - MAX_EXEMPTIONS} more exempted value(s) are listed only in the evidence file`,
    );
  const gaps: string[] = [];
  if (!measurement.elements)
    gaps.push('No rendered elements in scope were measured');
  if (measurement.truncated)
    gaps.push(
      `Stopped after maxElements (${config.maxElements}) elements; the rest of the scope was not measured`,
    );
  if (rules.includes('spacing') && !measurement.typedOM)
    gaps.push(
      'This browser has no CSS Typed OM (computedStyleMap), so margins, paddings and gaps were not measured',
    );
  const summary = `${elements(measurement.elements)} measured, ${evaluation.compared} value(s) compared, ${evaluation.offToken.length} off-token value(s)`;
  return {
    complete: gaps.length === 0,
    detail: gaps.length ? `${gaps.join('; ')}. ${summary}` : summary,
    observations: 1,
    analyzer: null,
    limitations: limitations.slice(0, 20),
    exemptions,
    findings,
  };
}
