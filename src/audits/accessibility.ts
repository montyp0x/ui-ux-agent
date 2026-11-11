// Automated accessibility scan results: the raw axe-core output parsed at the
// boundary into a bounded, typed result. Driver-independent: this module never
// imports a browser library, so the core can read results without Playwright.
//
// An automated scan finds only part of what makes a page accessible. A result
// without violations means "this analyzer found nothing it can detect
// automatically", never conformance with WCAG or any other standard. Keyboard
// and focus behaviour is outside this scan.
import { z } from 'zod';

// Read on every result, so a report built from one cannot be read as more
// than the scan it is.
export const ACCESSIBILITY_SCAN_LIMITATIONS = [
  'Automated axe-core scan: it detects only a subset of accessibility issues, and a result without violations does not establish WCAG conformance or any accessibility certification.',
  'Incomplete results are checks the analyzer could not decide; they need manual review and are not passes.',
  'Keyboard operation and focus order are not tested by this scan.',
  'Cross-origin frames are not analyzed.',
] as const;

// Output bounds: a scan of a large page can return thousands of nodes and
// whole subtrees of HTML; results keep counts and a bounded sample.
export const MAX_NODES_PER_RULE = 25;
export const MAX_HTML_LENGTH = 300;
export const MAX_MESSAGES_PER_NODE = 5;
export const MAX_MESSAGE_LENGTH = 300;

const impactSchema = z.enum(['minor', 'moderate', 'serious', 'critical']);
export type AccessibilityImpact = z.infer<typeof impactSchema>;

// Raw axe-core output (the documented AxeResults shape), parsed loosely in
// fields we do not read and strictly in the ones we do. An unexpected impact
// value or a missing rule id is invalid output, not a clean page.
const rawCheckSchema = z.looseObject({
  id: z.string(),
  message: z.string().optional().default(''),
});
// A node target: one entry per frame level, outermost first; an entry that is
// an array is a chain of shadow-DOM selectors.
const rawSelectorSchema = z.union([z.string(), z.array(z.string())]);
const rawNodeSchema = z.looseObject({
  html: z.string(),
  target: z.array(rawSelectorSchema),
  impact: impactSchema.nullish(),
  failureSummary: z.string().nullish(),
  any: z.array(rawCheckSchema).optional().default([]),
  all: z.array(rawCheckSchema).optional().default([]),
  none: z.array(rawCheckSchema).optional().default([]),
});
const rawRuleSchema = z.looseObject({
  id: z.string().min(1),
  impact: impactSchema.nullish(),
  tags: z.array(z.string()),
  description: z.string(),
  help: z.string(),
  helpUrl: z.string(),
  nodes: z.array(rawNodeSchema),
});
// Passed and inapplicable rules are only counted.
const rawCountedRuleSchema = z.looseObject({ id: z.string().min(1) });
export const rawAxeResultsSchema = z.looseObject({
  testEngine: z.looseObject({ name: z.string(), version: z.string() }),
  url: z.string(),
  violations: z.array(rawRuleSchema),
  incomplete: z.array(rawRuleSchema),
  passes: z.array(rawCountedRuleSchema),
  inapplicable: z.array(rawCountedRuleSchema),
});

export const accessibilityNodeSchema = z
  .object({
    // One selector per frame level, outermost first; shadow-DOM chains are
    // joined with " >> ".
    target: z.array(z.string()),
    html: z.string(),
    htmlTruncated: z.boolean(),
    impact: impactSchema.nullable(),
    // Why the node failed or why the analyzer could not decide.
    messages: z.array(z.string()),
  })
  .strict();
export type AccessibilityNode = z.infer<typeof accessibilityNodeSchema>;

export const accessibilityRuleResultSchema = z
  .object({
    ruleId: z.string(),
    impact: impactSchema.nullable(),
    help: z.string(),
    description: z.string(),
    helpUrl: z.string(),
    // WCAG success-criterion and level tags the analyzer maps the rule to
    // (e.g. "wcag2a", "wcag412"); empty for best-practice rules.
    wcag: z.array(z.string()),
    tags: z.array(z.string()),
    nodeCount: z.number().int().nonnegative(),
    nodes: z.array(accessibilityNodeSchema),
    nodesTruncated: z.boolean(),
  })
  .strict();
export type AccessibilityRuleResult = z.infer<
  typeof accessibilityRuleResultSchema
>;

export const accessibilityScopeSchema = z
  .object({
    // CSS selectors from explicit suite configuration, never model output.
    include: z.array(z.string().min(1)),
    exclude: z.array(z.string().min(1)),
  })
  .strict();
export type AccessibilityScope = z.infer<typeof accessibilityScopeSchema>;

const analyzerSchema = z
  .object({ name: z.literal('axe-core'), version: z.string().nullable() })
  .strict();

export const accessibilityScanErrorKinds = [
  // A configured scope selector matched nothing on the page.
  'scope_not_found',
  // The analyzer threw (injection failed, page closed, axe error).
  'analyzer_exception',
  'timeout',
  // The analyzer returned output that does not match its documented shape.
  'invalid_output',
] as const;

export const accessibilityScanSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      analyzer: analyzerSchema,
      url: z.string(),
      scope: accessibilityScopeSchema,
      // The axe rule tags the scan was limited to; empty runs axe's default
      // rule set.
      tags: z.array(z.string()),
      violations: z.array(accessibilityRuleResultSchema),
      // Needs manual review: the analyzer could not decide these checks.
      incomplete: z.array(accessibilityRuleResultSchema),
      passedRules: z.number().int().nonnegative(),
      inapplicableRules: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      limitations: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      analyzer: analyzerSchema,
      url: z.string(),
      scope: accessibilityScopeSchema,
      tags: z.array(z.string()),
      error: z
        .object({
          kind: z.enum(accessibilityScanErrorKinds),
          message: z.string(),
        })
        .strict(),
      durationMs: z.number().nonnegative(),
      limitations: z.array(z.string()),
    })
    .strict(),
]);
export type AccessibilityScan = z.infer<typeof accessibilityScanSchema>;
export type AccessibilityScanError = Extract<
  AccessibilityScan,
  { status: 'error' }
>['error'];

export type ScanContext = {
  scope: AccessibilityScope;
  tags: string[];
  durationMs: number;
};

const truncate = (value: string, max: number) =>
  value.length > max
    ? { text: `${value.slice(0, max)}…`, truncated: true }
    : { text: value, truncated: false };

// WCAG tags as axe-core names them: levels ("wcag2a", "wcag21aa") and
// success criteria ("wcag143", "wcag412").
const isWcagTag = (tag: string) => /^wcag\d+a{0,3}$/.test(tag);

function ruleResult(
  rule: z.infer<typeof rawRuleSchema>,
): AccessibilityRuleResult {
  const nodes = rule.nodes.slice(0, MAX_NODES_PER_RULE).map((node) => {
    const html = truncate(node.html, MAX_HTML_LENGTH);
    const messages = [
      ...new Set(
        [...node.any, ...node.all, ...node.none]
          .map((check) => check.message.trim())
          .filter(Boolean),
      ),
    ]
      .slice(0, MAX_MESSAGES_PER_NODE)
      .map((message) => truncate(message, MAX_MESSAGE_LENGTH).text);
    return {
      target: node.target.map((step) =>
        typeof step === 'string' ? step : step.join(' >> '),
      ),
      html: html.text,
      htmlTruncated: html.truncated,
      impact: node.impact ?? null,
      messages,
    };
  });
  return {
    ruleId: rule.id,
    impact: rule.impact ?? null,
    help: rule.help,
    description: rule.description,
    helpUrl: rule.helpUrl,
    wcag: rule.tags.filter(isWcagTag),
    tags: rule.tags,
    nodeCount: rule.nodes.length,
    nodes,
    nodesTruncated: rule.nodes.length > nodes.length,
  };
}

export function scanError(
  url: string,
  context: ScanContext,
  error: AccessibilityScanError,
  version: string | null = null,
): AccessibilityScan {
  return {
    status: 'error',
    analyzer: { name: 'axe-core', version },
    url,
    scope: context.scope,
    tags: context.tags,
    error: {
      kind: error.kind,
      message: truncate(error.message, 1000).text,
    },
    durationMs: context.durationMs,
    limitations: [...ACCESSIBILITY_SCAN_LIMITATIONS],
  };
}

// Parses raw analyzer output. Output that does not match the documented shape
// becomes an error result: a scan we cannot read is never reported as clean.
export function parseAxeResults(
  raw: unknown,
  url: string,
  context: ScanContext,
): AccessibilityScan {
  const parsed = rawAxeResultsSchema.safeParse(raw);
  if (!parsed.success)
    return scanError(url, context, {
      kind: 'invalid_output',
      message: `Analyzer output did not match the axe-core result shape: ${z.prettifyError(parsed.error)}`,
    });
  const results = parsed.data;
  if (results.testEngine.name !== 'axe-core')
    return scanError(url, context, {
      kind: 'invalid_output',
      message: `Unexpected analyzer engine "${results.testEngine.name}"`,
    });
  return {
    status: 'completed',
    analyzer: { name: 'axe-core', version: results.testEngine.version },
    url: results.url || url,
    scope: context.scope,
    tags: context.tags,
    violations: results.violations.map(ruleResult),
    incomplete: results.incomplete.map(ruleResult),
    passedRules: results.passes.length,
    inapplicableRules: results.inapplicable.length,
    durationMs: context.durationMs,
    limitations: [...ACCESSIBILITY_SCAN_LIMITATIONS],
  };
}
