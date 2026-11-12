// Maps responsive layout results onto the audit contract (src/audits/
// contract.ts) and declares the `layout.responsive` audit. Kept apart from
// the measurement so the mapping can follow contract changes on its own.
//
// The breakpoint is in each finding's description and tags
// (reproduction.viewport is the session's). Configured exceptions become
// `exemptions`; built-in WCAG 2.5.8 exceptions and unused exceptions are
// summarised in `limitations`; boxes, measurements and the exception ledger
// go to a JSON evidence file listed in `files`.
import type { AuditConfig } from './config.js';
import type {
  AuditExemption,
  AuditOutput,
  AuditOutputFinding,
} from './contract.js';
import { documentOverflowFinding } from './horizontal-overflow.js';
import type {
  LayoutAuditResult,
  LayoutBreakpoint,
  LayoutFinding,
  LayoutReviewCandidate,
} from './layout.js';
import type { AuditDefinition } from './registry.js';

export type LayoutResponsiveConfig = Extract<
  AuditConfig,
  { id: 'layout.responsive' }
>;

export const layoutResponsiveAudit: AuditDefinition<LayoutResponsiveConfig> = {
  id: 'layout.responsive',
  source: 'builtin',
  title: 'Responsive layout: clipping, occlusion and target size',
  drivers: ['playwright'],
  unsupported:
    'The macOS accessibility driver does not measure CSS layout or hit testing',
};

const LIMITATIONS = [
  'Measures CSS boxes and pointer hit testing at each breakpoint; it is not a visual review',
  'Reflow is emulated as the CSS viewport the zoom produces (WCAG 1.4.10), not browser UI zoom',
];

const RULE_IDS = {
  clipping: 'clipped-content',
  occlusion: 'occluded-control',
  'target-size': 'target-size',
} as const;

function where(breakpoint: LayoutBreakpoint | null): string {
  return breakpoint
    ? `[${breakpoint.name} ${breakpoint.width}x${breakpoint.height}]`
    : '[unknown breakpoint]';
}

function tags(breakpoint: LayoutBreakpoint | null): string[] {
  return breakpoint
    ? [
        `breakpoint:${breakpoint.name}`,
        ...(breakpoint.kind === 'reflow' ? ['reflow'] : []),
      ]
    : [];
}

// Severities are deliberate: losing a control or a required action is
// serious; clipped text, non-required occlusion and the WCAG 2.5.8 minimum are
// moderate; the optional 44px (2.5.5 AAA) minimum is minor.
function toFinding(
  finding: LayoutFinding,
  breakpoint: LayoutBreakpoint | null,
  files: string[],
): AuditOutputFinding {
  const base = {
    certainty: 'violation' as const,
    description: `${where(breakpoint)} ${finding.description}`,
    files,
  };
  switch (finding.rule) {
    case 'clipping': {
      const control = finding.items.some((item) => item.kind === 'control');
      return {
        ...base,
        ruleId: RULE_IDS.clipping,
        severity: control ? 'serious' : 'moderate',
        helpUrl:
          breakpoint?.kind === 'reflow'
            ? 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html'
            : null,
        tags: tags(breakpoint),
        nodeCount: finding.itemsTotal,
        targets: [
          {
            description: `overflow ${finding.overflowX}/${finding.overflowY} container, clip box ${finding.clipBox.width}x${finding.clipBox.height}`,
            selector: finding.selector,
            snippet: null,
          },
          ...finding.items.map((item) => ({
            description: `${item.kind} "${item.excerpt.slice(0, 40)}" cut ${Object.entries(
              item.cut,
            )
              .filter(([, px]) => px > 0)
              .map(([edge, px]) => `${edge} ${px}px`)
              .join(', ')}`,
            selector: item.selector,
            snippet: null,
          })),
        ].slice(0, 50),
      };
    }
    case 'occlusion':
      return {
        ...base,
        ruleId: RULE_IDS.occlusion,
        severity: finding.required ? 'serious' : 'moderate',
        helpUrl: null,
        tags: [...tags(breakpoint), ...(finding.required ? ['required'] : [])],
        nodeCount: 1,
        targets: [
          {
            description: `control "${finding.name.slice(0, 40)}", ${finding.covered}/${finding.samples} hit points covered`,
            selector: finding.selector,
            snippet: null,
          },
          {
            description: `covering layer ${finding.cover.box.width}x${finding.cover.box.height}`,
            selector: finding.cover.layer,
            snippet: null,
          },
        ],
      };
    case 'target-size': {
      const aa = finding.minimum <= 24;
      return {
        ...base,
        ruleId: RULE_IDS['target-size'],
        severity: aa ? 'moderate' : 'minor',
        helpUrl: aa
          ? 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html'
          : 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html',
        tags: [
          ...tags(breakpoint),
          ...(aa ? ['wcag22aa', 'wcag258'] : ['wcag21aaa', 'wcag255']),
        ],
        nodeCount: 1,
        targets: [
          {
            description: `target "${finding.name.slice(0, 40)}" ${finding.width}x${finding.height} CSS px`,
            selector: finding.selector,
            snippet: null,
          },
        ],
      };
    }
  }
}

function toCandidate(
  candidate: LayoutReviewCandidate,
  breakpoint: LayoutBreakpoint | null,
  files: string[],
): AuditOutputFinding {
  return {
    ruleId: `${RULE_IDS[candidate.rule]}.${candidate.kind}`,
    severity: null,
    certainty: 'needs_review',
    description: `${where(breakpoint)} Review: ${candidate.detail}`,
    helpUrl: null,
    tags: tags(breakpoint),
    nodeCount: 1,
    targets: [
      {
        description: candidate.kind,
        selector: candidate.selector,
        snippet: null,
      },
    ],
    files,
  };
}

const MAX_EXEMPTIONS = 200;

// One audit output from the breakpoint results of one checkpoint. Throws when
// any detector failed: an audit error is never reported as clean.
export function layoutAuditOutput(
  results: LayoutAuditResult[],
  options: {
    // The session's own viewport, covered by layout.horizontal-overflow.
    session: string;
    files?: string[];
  },
): AuditOutput {
  const files = options.files ?? [];
  const errors = results.flatMap((result) =>
    result.status === 'error'
      ? [
          `${result.breakpoint?.name ?? 'unknown'}: ${
            result.detail ??
            result.detectors
              .filter((detector) => detector.error !== null)
              .map((detector) => `${detector.rule} ${detector.error}`)
              .join('; ')
          }`,
        ]
      : [],
  );
  if (errors.length)
    throw new Error(
      `Layout audit failed at ${errors.join(' | ')}${files.length ? ` (measurements: ${files.join(', ')})` : ''}`,
    );
  const findings: AuditOutputFinding[] = [];
  const exemptions: AuditExemption[] = [];
  const notes: string[] = [];
  let unlisted = 0;
  const incomplete: string[] = [];
  for (const result of results) {
    const { breakpoint } = result;
    const name = breakpoint?.name ?? 'unknown';
    if (result.status === 'unsupported' || result.status === 'incomplete')
      incomplete.push(
        `${name}: ${
          result.detail ??
          result.detectors.flatMap((detector) => detector.incomplete).join('; ')
        }`,
      );
    // The session's own viewport is layout.horizontal-overflow's; reporting
    // it here too would count the same overflow twice.
    if (
      breakpoint &&
      breakpoint.name !== options.session &&
      result.horizontalOverflow !== null &&
      result.horizontalOverflow > 1
    ) {
      const finding = documentOverflowFinding(result.horizontalOverflow);
      findings.push({
        ...finding,
        description: `${where(breakpoint)} ${finding.description}`,
        tags: [
          ...tags(breakpoint),
          ...(breakpoint.kind === 'reflow' ? ['wcag21aa', 'wcag1410'] : []),
        ],
        files,
      });
    }
    for (const detector of result.detectors) {
      for (const finding of detector.findings)
        findings.push(toFinding(finding, breakpoint, files));
      for (const candidate of detector.reviewCandidates)
        findings.push(toCandidate(candidate, breakpoint, files));
      if (detector.truncated)
        incomplete.push(`${name}: ${detector.rule} hit its result limit`);
      const builtIn = new Map<string, number>();
      for (const entry of detector.exempted) {
        if (entry.exemption.kind !== 'exception') {
          builtIn.set(
            entry.exemption.kind,
            (builtIn.get(entry.exemption.kind) ?? 0) + 1,
          );
          continue;
        }
        if (exemptions.length >= MAX_EXEMPTIONS) {
          unlisted++;
          continue;
        }
        const measured = toFinding(entry.measured, breakpoint, files);
        exemptions.push({
          ruleId: measured.ruleId,
          target: {
            ...measured.targets[0]!,
            description: `${where(breakpoint)} ${measured.targets[0]!.description}`,
            snippet: null,
            reason: entry.measured.description,
          },
          reason: `Exception #${entry.exemption.index} (${entry.exemption.selector}, matched on ${entry.exemption.matchedOn}): ${entry.exemption.reason}`,
        });
      }
      for (const [kind, count] of builtIn)
        notes.push(
          `${name}: ${count} ${detector.rule} exempted by the WCAG 2.5.8 ${kind} exception`,
        );
    }
    for (const exception of result.exceptions)
      if (exception.active && !exception.uses)
        notes.push(
          `${name}: exception #${exception.index} (${exception.selector}) matched nothing`,
        );
  }
  if (unlisted)
    notes.push(
      `${unlisted} more exempted items${files.length ? ` in ${files.join(', ')}` : ''}`,
    );
  const limitations = [...LIMITATIONS, ...notes];
  return {
    complete: !incomplete.length,
    detail: incomplete.length ? incomplete.join(' | ').slice(0, 2000) : null,
    observations: results.filter(
      (result) => result.status === 'clean' || result.status === 'findings',
    ).length,
    analyzer: null,
    limitations:
      limitations.length > 20
        ? [
            ...limitations.slice(0, 19),
            `${limitations.length - 19} more notes${files.length ? ` in ${files.join(', ')}` : ''}`,
          ]
        : limitations,
    exemptions,
    findings: findings.slice(0, 500),
  };
}
