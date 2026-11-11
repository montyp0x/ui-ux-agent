// The quality verdict: measured checks of the observed UI, kept separate from
// the functional outcome. Model concerns (hypothesis findings) never count.
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
};

// Checks this engine version does not perform, listed on every result so a
// report cannot be read as covering them.
export const NOT_IMPLEMENTED_CHECKS: QualityGap[] = [
  {
    id: 'accessibility.audit',
    reason:
      'No accessibility analyzer runs in this engine version; this is not an accessibility audit',
  },
  {
    id: 'visual.baseline',
    reason: 'No reviewed visual baseline comparison in this engine version',
  },
  {
    id: 'keyboard.focus',
    reason:
      'Keyboard-only and focus behaviour is not checked in this engine version',
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
    id: 'layout.horizontal-overflow',
    unsupported: {
      macos:
        'The macOS accessibility driver does not measure document overflow',
    },
    evaluate(inputs) {
      const findings = findingIndices(inputs.findings, 'overflow');
      return {
        id: this.id,
        source: 'builtin',
        status: findings.length ? 'failed' : 'passed',
        observations: inputs.observations,
        findings,
        detail: findings.length
          ? 'Document wider than the viewport in an observed state'
          : null,
      };
    },
  },
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

export function verdict(
  executed: QualityCheck[],
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
  if (unclear.length)
    return {
      verdict: 'not_evaluated',
      reason: `No check failed, but ${unclear.map((check) => `${check.id} was ${check.status}`).join(', ')}`,
    };
  return {
    verdict: 'pass',
    reason: `All ${executed.length} executed quality checks passed (${executed.map((check) => check.id).join(', ')}); checks listed as unsupported were not run`,
  };
}

export function evaluateQuality(inputs: QualityInputs): Quality {
  const executed: QualityCheck[] = [];
  const skipped: QualityGap[] = [];
  const unsupported: QualityGap[] = [...NOT_IMPLEMENTED_CHECKS];
  for (const check of BUILT_IN) {
    const reason = check.unsupported[inputs.platform];
    if (reason) unsupported.push({ id: check.id, reason });
    else if (!inputs.observations)
      skipped.push({ id: check.id, reason: 'No UI state was observed' });
    else executed.push(check.evaluate(inputs));
  }
  return { ...verdict(executed), executed, skipped, unsupported };
}
