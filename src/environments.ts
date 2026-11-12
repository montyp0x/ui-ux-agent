// Suite-owned named environments (locale, time zone, colour scheme, reduced
// motion, forced colours, contrast, pseudo-localized long text) and the
// explicit selection of the environment × viewport combinations a suite runs.
//
// Selection is never an implicit cartesian product: a suite with
// environments lists its combinations, or declares a small matrix with an
// explicit cap (and include/exclude), and a selection over its cap is a
// configuration error. Suites without environments run every viewport once,
// as before, and record no environment.
//
// A leaf module (zod and Playwright types only), so contracts.ts, the
// drivers and browser.ts can all import it.
import type { Page } from 'playwright';
import { z } from 'zod';

// The most environment × viewport combinations one suite can select.
export const MAX_RUN_COMBINATIONS = 24;
export const MAX_ENVIRONMENTS = 12;

const name = z.string().regex(/^[a-z0-9-]+$/);

const localeSchema = z
  .string()
  .min(2)
  .max(35)
  .refine((value) => {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    } catch {
      return false;
    }
  }, 'locale must be a BCP 47 language tag such as de-DE');

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'timezone must be an IANA time zone such as Europe/Berlin');

// Pseudo-localization: the harness appends synthetic padding, between ⟦ and
// ⟧, to the application's own visible text in the page, to find layouts that
// break when translations run long. The original text is kept in front, so
// suite targets and checks still match. Never typed into a field, and never
// a translation.
export const pseudoLocalizationSchema = z
  .object({
    // Padding per character of each text, 0.1-3 (0.4 = 40% longer). Omitted:
    // tiered by length, as short strings grow most in translation (100% up
    // to 10 characters, down to 30% beyond 70).
    expansion: z.number().min(0.1).max(3).optional(),
  })
  .strict();
export type PseudoLocalization = z.infer<typeof pseudoLocalizationSchema>;

// One named environment. A setting left out keeps the browser's default,
// which can differ between machines: set it explicitly where it matters.
export const environmentSchema = z
  .object({
    name,
    locale: localeSchema.optional(),
    timezone: timezoneSchema.optional(),
    colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
    reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
    forcedColors: z.enum(['active', 'none']).optional(),
    contrast: z.enum(['more', 'no-preference']).optional(),
    pseudoLocalization: pseudoLocalizationSchema.optional(),
  })
  .strict();
export type Environment = z.infer<typeof environmentSchema>;

export const combinationSchema = z
  .object({ environment: name, viewport: name })
  .strict();
export type Combination = z.infer<typeof combinationSchema>;

// environments × viewports, minus exclude, plus include, at most max.
export const environmentMatrixSchema = z
  .object({
    environments: z.array(name).min(1).max(MAX_ENVIRONMENTS),
    viewports: z.array(name).min(1).max(20),
    exclude: z.array(combinationSchema).max(100).default([]),
    include: z.array(combinationSchema).max(MAX_RUN_COMBINATIONS).default([]),
    // Required: the most combinations the matrix may select.
    max: z
      .number({
        error: (issue) =>
          issue.input === undefined
            ? 'matrix.max is required: the most environment × viewport combinations the matrix may select'
            : undefined,
      })
      .int()
      .min(1)
      .max(MAX_RUN_COMBINATIONS),
  })
  .strict();
export type EnvironmentMatrix = z.infer<typeof environmentMatrixSchema>;

// The suite fields, spread into the suite object in contracts.ts.
export const environmentSuiteShape = {
  environments: z.array(environmentSchema).min(1).max(MAX_ENVIRONMENTS).optional(),
  // The environment × viewport combinations to run, in order.
  combinations: z
    .array(combinationSchema)
    .min(1)
    .max(MAX_RUN_COMBINATIONS)
    .optional(),
  matrix: environmentMatrixSchema.optional(),
};

type EnvironmentSuite = {
  platform: 'web' | 'macos';
  viewports: { name: string }[];
  environments?: Environment[];
  combinations?: Combination[];
  matrix?: EnvironmentMatrix;
};

const cellText = (cell: Combination) => `${cell.environment}/${cell.viewport}`;

// The combinations a suite selects, in run order, and the problems that make
// the selection invalid (empty when valid).
export function selectCombinations(suite: EnvironmentSuite): {
  combinations: Combination[];
  issues: string[];
} {
  const issues: string[] = [];
  const { environments, combinations, matrix } = suite;
  if (!environments) {
    if (combinations || matrix)
      issues.push('combinations and matrix select environments; add environments');
    return { combinations: [], issues };
  }
  if (suite.platform === 'macos')
    issues.push(
      'environments apply to web suites only: the macOS driver does not emulate locale, time zone or media settings',
    );
  const names = environments.map((environment) => environment.name);
  if (new Set(names).size !== names.length)
    issues.push('Environment names must be unique');
  if (!combinations && !matrix) {
    issues.push(
      'A suite with environments must list the environment × viewport combinations to run (combinations), or a matrix with an explicit max; runs never expand to every combination implicitly',
    );
    return { combinations: [], issues };
  }
  if (combinations && matrix) {
    issues.push('Use combinations or matrix, not both');
    return { combinations: [], issues };
  }
  const viewports = new Set(suite.viewports.map((viewport) => viewport.name));
  const known = new Set(names);
  const checkCell = (cell: Combination, where: string) => {
    if (!known.has(cell.environment))
      issues.push(`${where}: unknown environment ${cell.environment}`);
    if (!viewports.has(cell.viewport))
      issues.push(`${where}: unknown viewport ${cell.viewport}`);
  };
  let selected: Combination[];
  if (combinations) {
    combinations.forEach((cell, index) =>
      checkCell(cell, `combinations[${index}] ${cellText(cell)}`),
    );
    selected = combinations;
  } else {
    const m = matrix!;
    for (const environment of m.environments)
      if (!known.has(environment))
        issues.push(`matrix.environments: unknown environment ${environment}`);
    for (const viewport of m.viewports)
      if (!viewports.has(viewport))
        issues.push(`matrix.viewports: unknown viewport ${viewport}`);
    for (const list of [m.environments, m.viewports])
      if (new Set(list).size !== list.length)
        issues.push('matrix.environments and matrix.viewports must not repeat a name');
    const product = m.environments.flatMap((environment) =>
      m.viewports.map((viewport) => ({ environment, viewport })),
    );
    const inProduct = new Set(product.map(cellText));
    const excluded = new Set<string>();
    m.exclude.forEach((cell, index) => {
      if (!inProduct.has(cellText(cell)))
        issues.push(
          `matrix.exclude[${index}] ${cellText(cell)} is not in environments × viewports`,
        );
      excluded.add(cellText(cell));
    });
    m.include.forEach((cell, index) => {
      checkCell(cell, `matrix.include[${index}] ${cellText(cell)}`);
      if (inProduct.has(cellText(cell)) && !excluded.has(cellText(cell)))
        issues.push(
          `matrix.include[${index}] ${cellText(cell)} is already in environments × viewports`,
        );
    });
    selected = [
      ...product.filter((cell) => !excluded.has(cellText(cell))),
      ...m.include,
    ];
    if (selected.length > m.max)
      issues.push(
        `matrix selects ${selected.length} environment × viewport combinations (${m.environments.length} environments × ${m.viewports.length} viewports - ${m.exclude.length} excluded + ${m.include.length} included), over its max of ${m.max}; exclude combinations, list them in combinations, or raise max (at most ${MAX_RUN_COMBINATIONS})`,
      );
  }
  const seen = new Set<string>();
  for (const cell of selected) {
    if (seen.has(cellText(cell)))
      issues.push(`Combination ${cellText(cell)} is selected twice`);
    seen.add(cellText(cell));
  }
  if (!selected.length)
    issues.push('The environment selection selects no combination');
  return { combinations: issues.length ? [] : selected, issues };
}

// ---------------------------------------------------------------------------
// What a run records about its environment (result.environment).

export const PSEUDO_MARKER_OPEN = '⟦';
export const PSEUDO_MARKER_CLOSE = '⟧';

export const resultEnvironmentSchema = environmentSchema
  .extend({
    // True when the harness expanded the page's text (pseudoLocalization):
    // findings in this run were measured on synthetic text, marked ⟦…⟧ in
    // screenshots, snapshots and control names.
    syntheticText: z.boolean(),
  })
  .strict();
export type ResultEnvironment = z.infer<typeof resultEnvironmentSchema>;

export function resultEnvironment(environment: Environment): ResultEnvironment {
  return { ...environment, syntheticText: !!environment.pseudoLocalization };
}

// Browser context options for an environment (Playwright names).
export function environmentContextOptions(environment: Environment | null): {
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
  forcedColors?: 'active' | 'none';
  contrast?: 'more' | 'no-preference';
} {
  if (!environment) return {};
  return {
    ...(environment.locale ? { locale: environment.locale } : {}),
    ...(environment.timezone ? { timezoneId: environment.timezone } : {}),
    ...(environment.colorScheme ? { colorScheme: environment.colorScheme } : {}),
    ...(environment.reducedMotion
      ? { reducedMotion: environment.reducedMotion }
      : {}),
    ...(environment.forcedColors
      ? { forcedColors: environment.forcedColors }
      : {}),
    ...(environment.contrast ? { contrast: environment.contrast } : {}),
  };
}

// What the page reports, read in the page after it loaded.
export const environmentProbeSchema = z
  .object({
    locale: z.string(),
    timezone: z.string(),
    colorScheme: z.enum(['light', 'dark', 'no-preference']),
    reducedMotion: z.enum(['reduce', 'no-preference']),
    forcedColors: z.enum(['active', 'none']),
    contrast: z.enum(['more', 'no-preference']),
  })
  .strict();
export type EnvironmentProbe = z.infer<typeof environmentProbeSchema>;

// A string, not a function: serialized functions can carry transpiler helpers.
export const ENVIRONMENT_PROBE = `(() => ({
  locale: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'no-preference',
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
  forcedColors: matchMedia('(forced-colors: active)').matches ? 'active' : 'none',
  contrast: matchMedia('(prefers-contrast: more)').matches ? 'more' : 'no-preference',
}))()`;

// The requested settings the page does not show: each is a reason the run
// did not measure the environment it names.
export function unappliedSettings(
  environment: Environment,
  probe: EnvironmentProbe,
): string[] {
  const out: string[] = [];
  if (
    environment.locale &&
    probe.locale.toLowerCase() !== environment.locale.toLowerCase()
  )
    out.push(`locale ${environment.locale} (page reports ${probe.locale})`);
  if (environment.timezone && probe.timezone !== environment.timezone)
    out.push(`timezone ${environment.timezone} (page reports ${probe.timezone})`);
  for (const key of [
    'colorScheme',
    'reducedMotion',
    'forcedColors',
    'contrast',
  ] as const)
    if (environment[key] && probe[key] !== environment[key])
      out.push(`${key} ${environment[key]} (page reports ${probe[key]})`);
  return out;
}

// ---------------------------------------------------------------------------
// Pseudo-localization.

// The body of pad(text, expansion), shared by Node (tests, pseudoPad) and the
// page script, so both expand text identically. Keeps leading and trailing
// whitespace, appends " ⟦padding⟧" after the text, and breaks the padding
// into words of up to 10 characters (long, compound-like words).
const PAD_BODY = `
  var trimmed = text.trim();
  if (!trimmed) return text;
  var length = Array.from(trimmed).length;
  var factor = typeof expansion === 'number' ? expansion :
    length <= 10 ? 1 : length <= 20 ? 0.8 : length <= 30 ? 0.6 :
    length <= 50 ? 0.5 : length <= 70 ? 0.4 : 0.3;
  var count = Math.max(2, Math.round(length * factor));
  var letters = 'ǟβçđéƒğĥîĵķłɱñöþqŕšţûṽŵẋÿž';
  var padding = '';
  for (var i = 0; i < count; i++)
    padding += (i > 0 && i % 10 === 0 ? ' ' : '') + letters[i % letters.length];
  var end = /\\s*$/.exec(text)[0];
  return text.slice(0, text.length - end.length) + ' ${PSEUDO_MARKER_OPEN}' + padding + '${PSEUDO_MARKER_CLOSE}' + end;
`;
const MARK_SOURCE = ` ${PSEUDO_MARKER_OPEN}[^${PSEUDO_MARKER_CLOSE}]*${PSEUDO_MARKER_CLOSE}`;

// Node-side pad, for tests and documentation examples.
export const pseudoPad = new Function('text', 'expansion', PAD_BODY) as (
  text: string,
  expansion?: number,
) => string;

// Removes the harness's padding (restoring the application's text).
export const withoutPseudo = (text: string): string =>
  text.replace(new RegExp(MARK_SOURCE, 'g'), '');

// The init script that expands the application's visible text in every page
// and frame of the session, before and after the application renders.
// Form fields (input, textarea, select and its options), editable content,
// code, scripts and styles are never changed, so nothing a user types (or a
// fill interaction types) is padded, and a field's value stays its own.
// Attributes (placeholder, aria-label, title, alt) and shadow roots are not
// expanded.
export function pseudoLocalizationScript(options: PseudoLocalization): string {
  const expansion =
    options.expansion === undefined ? 'null' : String(options.expansion);
  return `(() => {
  function pad(text, expansion) {${PAD_BODY}}
  var EXPANSION = ${expansion};
  var MARK = new RegExp(${JSON.stringify(MARK_SOURCE)}, 'g');
  var SKIP = 'script,style,noscript,template,textarea,input,select,option,code,pre,kbd,samp,svg';
  var done = new WeakMap();
  function expand(node) {
    var parent = node.parentElement;
    if (!parent || parent.isContentEditable || parent.closest(SKIP)) return;
    var current = node.data;
    if (done.get(node) === current) return;
    var original = current.replace(MARK, '');
    if (!original.trim()) return;
    var next = pad(original, EXPANSION);
    done.set(node, next);
    if (next !== current) node.data = next;
  }
  function walk(root) {
    if (root.nodeType === 3) return expand(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) expand(node);
  }
  new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) {
      var record = records[r];
      if (record.type === 'characterData') expand(record.target);
      else for (var a = 0; a < record.addedNodes.length; a++) walk(record.addedNodes[a]);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { walk(document); }, { once: true });
  else walk(document);
})();`;
}

const pseudoPages = new WeakSet<Page>();
export const markPseudoLocalized = (page: Page): void => {
  pseudoPages.add(page);
};
export const isPseudoLocalized = (page: Page): boolean => pseudoPages.has(page);

// An accessible name or label as a pattern that also matches it with the
// harness's padding after any of its text nodes, so a suite's target names
// keep matching under pseudo-localization. Whitespace matches any run.
export function pseudoNamePattern(text: string): RegExp {
  const gap = `(?:${MARK_SOURCE})?`;
  const body = Array.from(text.trim())
    .map((char) =>
      /\s/.test(char) ? '\\s+' : char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'),
    )
    .map((part) => `${part}${gap}`)
    .join('');
  return new RegExp(`^${body}$`, 'u');
}
