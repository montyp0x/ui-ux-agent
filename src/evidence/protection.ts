// One run's evidence protection: the redactor, the screenshot protection
// drivers apply before capture, and the status of every evidence format.
// Built once per run by runSuite; also the entry point for other capture code
// (visual baselines) that must apply the same protections.
import type { Target } from '../target.js';
import {
  evidenceFormats,
  sensitive,
  type EvidenceReport,
  type RunEvidencePolicy,
  type FormatContext,
  type FormatStatus,
} from './policy.js';
import {
  Redactor,
  shortSecretLimitation,
  type TextPattern,
} from './redact.js';

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
  // Its patterns are read at every capture, so values a run learns
  // (beginRun) are masked in screenshots of sessions opened before.
  screenshots: ScreenshotProtection;
  formats: FormatStatus[];
  // The suite declared content it wants protected.
  sensitive: boolean;
  // Starts a run (runs are sequential): its dataLifecycle setup values,
  // except the keys in publicValues, become secrets of the suite from now on.
  beginRun(data: Record<string, string>, publicValues: readonly string[]): void;
  report(sanitizedFiles: number): EvidenceReport;
  // Warnings for the suite as loaded (declared secrets too short to redact),
  // also listed in every result's evidence.limitations.
  warnings: readonly string[];
};

export function evidenceProtection(
  policy: RunEvidencePolicy,
  env: Record<string, string | undefined>,
  context: FormatContext,
): EvidenceProtection {
  const redactor = new Redactor({
    patterns: policy.redact,
    envNames: policy.redactEnv,
    env,
  });
  const formats = evidenceFormats(policy, context);
  // Declared secrets too short to redact apply to every run.
  const suiteLimitations = redactor.tooShort.map(shortSecretLimitation);
  // The current run's redacted setup value keys, and those too short.
  let redactedData: string[] = [];
  let runLimitations: string[] = [];
  return {
    redactor,
    screenshots: {
      masks: policy.masks,
      get patterns() {
        return redactor.patterns;
      },
      maskColor: MASK_COLOR,
    },
    formats,
    sensitive: sensitive(policy),
    warnings: suiteLimitations,
    beginRun(data, publicValues) {
      redactedData = [];
      runLimitations = [];
      for (const [key, value] of Object.entries(data)) {
        if (publicValues.includes(key) || !value) continue;
        if (redactor.addSecret(`data:${key}`, value)) redactedData.push(key);
        else
          runLimitations.push(
            shortSecretLimitation(`dataLifecycle setup value data.${key}`),
          );
      }
    },
    report: (sanitizedFiles) => ({
      declaredPatterns: redactor.declared.length,
      builtInPatterns: redactor.builtIn.length,
      redactedEnv: redactor.literals.flatMap((entry) =>
        entry.label.startsWith('env:') ? [entry.label.slice('env:'.length)] : [],
      ),
      redactedData: [...redactedData],
      limitations: [...suiteLimitations, ...runLimitations],
      masks: policy.masks.length,
      formats,
      sanitizedFiles,
    }),
  };
}
