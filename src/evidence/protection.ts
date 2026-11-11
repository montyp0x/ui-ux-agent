// One run's evidence protection: the redactor, the screenshot protection
// drivers apply before capture, and the status of every evidence format.
// Built once per run by runSuite; also the entry point for other capture code
// (visual baselines) that must apply the same protections.
import type { Target } from '../target.js';
import {
  evidenceFormats,
  sensitive,
  type EvidencePolicy,
  type EvidenceReport,
  type FormatContext,
  type FormatStatus,
} from './policy.js';
import { Redactor, type TextPattern } from './redact.js';

// What a driver needs to protect a screenshot before it is captured: elements
// to cover, and text patterns whose visible matches (page text and input
// values) are covered too.
export type ScreenshotProtection = {
  masks: readonly Target[];
  patterns: readonly TextPattern[];
  // Fill colour of masked areas.
  maskColor: string;
};

export const MASK_COLOR = '#FF00FF';

export type EvidenceProtection = {
  redactor: Redactor;
  screenshots: ScreenshotProtection;
  formats: FormatStatus[];
  // The suite declared content it wants protected.
  sensitive: boolean;
  report(sanitizedFiles: number): EvidenceReport;
};

export function evidenceProtection(
  policy: EvidencePolicy,
  env: Record<string, string | undefined>,
  context: FormatContext,
): EvidenceProtection {
  const redactor = new Redactor({
    patterns: policy.redact,
    envNames: policy.redactEnv,
    env,
  });
  const formats = evidenceFormats(policy, context);
  return {
    redactor,
    screenshots: {
      masks: policy.masks,
      patterns: redactor.patterns,
      maskColor: MASK_COLOR,
    },
    formats,
    sensitive: sensitive(policy),
    report: (sanitizedFiles) => ({
      declaredPatterns: redactor.declared.length,
      builtInPatterns: redactor.builtIn.length,
      redactedEnv: redactor.literals.map((entry) =>
        entry.label.replace(/^env:/, ''),
      ),
      masks: policy.masks.length,
      formats,
      sanitizedFiles,
    }),
  };
}
