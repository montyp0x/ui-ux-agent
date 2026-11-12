// The quality verdict: measured checks of the observed UI, kept separate from
// the functional outcome. Model concerns (hypothesis findings) never count.
import type { AuditsResult } from './audits/contract.js';
import type { Finding, Quality, QualityCheck, QualityGap } from './results.js';

export type QualityInputs = {
  platform: 'web' | 'macos';
  // Observed states the built-in checks measured.
  observations: number;
  findings: Finding[];
  // Request-policy blocks to the suite's own origins during the run.
  policyBlocks: number;
  // False when evidence capture failed before run-wide findings were recorded.
  evidenceComplete: boolean;
  // The run's audit record; omitted when no audit was configured.
  audits?: AuditsResult;
  // Run-wide gaps of the session's browser engine (src/browser-support.ts),
  // listed as unsupported; they never change the verdict.
  engineGaps?: QualityGap[];
  // Settings of the run's suite environment the engine does not emulate
  // (src/browser-support.ts environmentEmulation): listed as unsupported, and
  // the verdict cannot pass, since the checks measured another environment.
  environmentGaps?: QualityGap[];
};

// Checks this engine version does not perform, listed on every result so a
// report cannot be read as covering them.
export const NOT_IMPLEMENTED_CHECKS: QualityGap[] = [
  {
    id: 'accessibility.audit',
    reason:
      'No accessibility analyzer was configured (add accessibility.axe to audits.checks); this is not an accessibility audit',
  },
  {
    id: 'visual.baseline',
    reason:
      'No visual baseline comparison was configured (add visual.baseline to audits.checks and pass --baselines DIR)',
  },
  {
    id: 'keyboard.focus',
    reason:
      'Keyboard focus behaviour was not checked (run a keyboard-only journey with the keyboard.focus audit)',
  },
];

const findingIndices = (findings: Finding[], category: string) =>
  findings.flatMap((finding, index) =>
    finding.kind === 'observed' && finding.category === category ? [index] : [],
  );

type BuiltIn = {
  id: string;
  unsupported: Partial<Record<QualityInputs['platform'], string>>;
  evaluate(inputs: QualityInputs): QualityCheck;
};

const BUILT_IN: BuiltIn[] = [
  {
    id: 'runtime.browser-errors',
    unsupported: {
      macos: 'The macOS accessibility driver does not collect runtime errors',
    },
    evaluate(inputs) {
      const findings = findingIndices(inputs.findings, 'browser-error');
      const base = {
        id: this.id,
        source: 'builtin' as const,
        observations: inputs.observations,
        findings,
        audit: null,
      };
      if (!inputs.evidenceComplete)
        return {
          ...base,
          status: 'errored',
          detail: 'Evidence capture failed before runtime errors were recorded',
        };
      if (findings.length && inputs.policyBlocks)
        return {
          ...base,
          status: 'inconclusive',
          detail: `${inputs.policyBlocks} request(s) blocked by the test policy may have caused the runtime errors`,
        };
      return {
        ...base,
        status: findings.length ? 'failed' : 'passed',
        detail: findings.length
          ? 'Uncaught page errors or HTTP 5xx responses were observed'
          : null,
      };
    },
  },
];

// One quality check per configured audit, from its runs. An audit that never
// ran, or that the driver does not support, is a gap that blocks a pass.
export function auditQuality(audits: AuditsResult): {
  executed: QualityCheck[];
  skipped: QualityGap[];
  unsupported: QualityGap[];
} {
  const executed: QualityCheck[] = [];
  const skipped: QualityGap[] = [];
  const unsupported: QualityGap[] = [];
  for (const id of audits.configured) {
    const runs = audits.runs.flatMap((run, index) =>
      run.auditId === id ? [index] : [],
    );
    const notReached = audits.notReached
      .filter((gap) => gap.auditId === id)
      .map((gap) => gap.at);
    if (!runs.length) {
      skipped.push({
        id,
        reason: notReached.length
          ? `No UI state was observed at its checkpoints (${notReached.join(', ')} not reached)`
          : 'No UI state was observed',
      });
      continue;
    }
    const records = runs.map((index) => audits.runs[index]!);
    const ran = records.filter((run) => run.status !== 'unsupported');
    if (!ran.length) {
      unsupported.push({ id, reason: records[0]!.detail ?? 'Unsupported' });
      continue;
    }
    const all = audits.findings.flatMap((finding, index) =>
      finding.auditId === id ? [index] : [],
    );
    const gating = all.filter((index) => audits.findings[index]!.gating);
    const errored = ran.find((run) => run.status === 'error');
    const incomplete = ran.find((run) => run.status === 'incomplete');
    const below = all.length - gating.length;
    const detail = [
      gating.length
        ? `${gating.length} finding(s) at or above ${audits.failOn} at ${[...new Set(gating.flatMap((index) => audits.findings[index]!.checkpoints))].join(', ')}`
        : '',
      errored
        ? `audit error at ${errored.checkpoint.id}: ${errored.detail ?? 'unknown'}`
        : '',
      incomplete
        ? `incomplete at ${incomplete.checkpoint.id}: ${incomplete.detail ?? 'not all of the state was covered'}`
        : '',
      below
        ? `${below} other finding(s) below the ${audits.failOn} threshold or needing review`
        : '',
      notReached.length ? `not reached: ${notReached.join(', ')}` : '',
    ].filter(Boolean);
    executed.push({
      id,
      source: 'audit',
      status: gating.length
        ? 'failed'
        : errored
          ? 'errored'
          : incomplete
            ? 'inconclusive'
            : 'passed',
      observations: ran.reduce((sum, run) => sum + run.observations, 0),
      findings: [],
      audit: { runs, findings: gating },
      detail: detail.length ? detail.join('; ') : null,
    });
  }
  return { executed, skipped, unsupported };
}

export function verdict(
  executed: QualityCheck[],
  // Configured audits that were unsupported or never ran.
  gaps: QualityGap[] = [],
  // Environment settings the run did not emulate.
  environmentGaps: QualityGap[] = [],
): Pick<Quality, 'verdict' | 'reason'> {
  const failed = executed.filter((check) => check.status === 'failed');
  const unclear = executed.filter(
    (check) => check.status === 'inconclusive' || check.status === 'errored',
  );
  if (failed.length)
    return {
      verdict: 'fail',
      reason: `${failed.length} of ${executed.length} executed quality checks failed: ${failed.map((check) => check.id).join(', ')}`,
    };
  if (!executed.length)
    return {
      verdict: 'not_evaluated',
      reason: 'No quality checks were executed',
    };
  if (unclear.length || gaps.length || environmentGaps.length)
    return {
      verdict: 'not_evaluated',
      reason: `No check failed, but ${[
        ...unclear.map((check) => `${check.id} was ${check.status}`),
        ...gaps.map(
          (gap) => `configured audit ${gap.id} did not run (${gap.reason})`,
        ),
        ...environmentGaps.map(
          (gap) =>
            `the run did not emulate ${gap.id}, so the checks measured another environment (${gap.reason})`,
        ),
      ].join(', ')}`,
    };
  return {
    verdict: 'pass',
    reason: `All ${executed.length} executed quality checks passed (${executed.map((check) => check.id).join(', ')}); checks listed as unsupported were not run`,
  };
}

export function evaluateQuality(inputs: QualityInputs): Quality {
  const audits = inputs.audits
    ? auditQuality(inputs.audits)
    : { executed: [], skipped: [], unsupported: [] };
  const executed: QualityCheck[] = [...audits.executed];
  const skipped: QualityGap[] = [...audits.skipped];
  // A configured axe-core scan is reported as its own audit check, with the
  // scan's limitations on each run, so the not-configured gap is dropped.
  // Likewise a configured visual.baseline audit replaces its gap.
  const axe = inputs.audits?.configured.includes('accessibility.axe');
  const visual = inputs.audits?.configured.includes('visual.baseline');
  // Likewise a configured keyboard.focus audit reports its own coverage.
  const keyboard = inputs.audits?.configured.includes('keyboard.focus');
  const unsupported: QualityGap[] = [
    ...NOT_IMPLEMENTED_CHECKS.filter(
      (gap) =>
        !(axe && gap.id === 'accessibility.audit') &&
        !(visual && gap.id === 'visual.baseline') &&
        !(keyboard && gap.id === 'keyboard.focus'),
    ),
    ...audits.unsupported,
    ...(inputs.engineGaps ?? []),
    ...(inputs.environmentGaps ?? []),
  ];
  for (const check of BUILT_IN) {
    const reason = check.unsupported[inputs.platform];
    if (reason) unsupported.push({ id: check.id, reason });
    else if (!inputs.observations)
      skipped.push({ id: check.id, reason: 'No UI state was observed' });
    else executed.push(check.evaluate(inputs));
  }
  return {
    ...verdict(
      executed,
      [...audits.unsupported, ...audits.skipped],
      inputs.environmentGaps ?? [],
    ),
    executed,
    skipped,
    unsupported,
  };
}
