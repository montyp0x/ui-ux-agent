// Loading inputs and writing a comparison's files (comparison.json and
// comparison.html), shared by `npm run compare` and `npm run run -- --compare`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ComparisonInputError,
  compareRuns,
  loadRun,
  type Comparison,
} from './compare.js';
import { comparisonHTML } from './compare-report.js';
import { Redactor } from './evidence/redact.js';
import { gateSchema, type Gate } from './gate.js';

export async function loadGate(path: string | undefined): Promise<Gate> {
  if (!path) return gateSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (caught) {
    throw new ComparisonInputError(
      `Cannot read gate ${path}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  const parsed = gateSchema.safeParse(raw);
  if (!parsed.success)
    throw new ComparisonInputError(
      `Invalid gate ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
    );
  return parsed.data;
}

// What a run's own suite.json declares secret: its redaction patterns and
// redactEnv names, so the comparison applies them too.
const suiteSecretsSchema = z.object({
  evidence: z
    .object({
      redact: z
        .array(
          z.object({
            pattern: z.string().min(1),
            ignoreCase: z.boolean().optional(),
            label: z.string().optional(),
          }),
        )
        .default([]),
      redactEnv: z.array(z.string()).default([]),
    })
    .partial()
    .optional(),
});

async function runSecrets(directory: string) {
  try {
    const parsed = suiteSecretsSchema.safeParse(
      JSON.parse(await readFile(join(directory, 'suite.json'), 'utf8')),
    );
    if (!parsed.success) return { patterns: [], envNames: [] };
    const patterns = (parsed.data.evidence?.redact ?? []).filter((entry) => {
      try {
        new RegExp(entry.pattern);
        return true;
      } catch {
        return false;
      }
    });
    return { patterns, envNames: parsed.data.evidence?.redactEnv ?? [] };
  } catch {
    return { patterns: [], envNames: [] };
  }
}

// A redactor with both runs' declared patterns and secret variables plus the
// environment's credentials: comparison output never holds their values.
export async function comparisonRedactor(
  directories: string[],
  env: Record<string, string | undefined>,
): Promise<Redactor> {
  const secrets = await Promise.all(directories.map(runSecrets));
  return new Redactor({
    patterns: secrets.flatMap((entry) => entry.patterns),
    envNames: [...new Set(secrets.flatMap((entry) => entry.envNames))],
    env,
  });
}

export type ComparisonFiles = {
  comparison: Comparison;
  directory: string;
  json: string;
  html: string;
  redactor: Redactor;
};

// Compares two runs and writes the redacted comparison into `out`, a new
// directory (default: comparison-<time> inside the candidate run, so it is
// pruned with it). Existing directories are never reused.
export async function writeComparison(options: {
  base: string;
  candidate: string;
  gate: Gate;
  out?: string;
  env?: Record<string, string | undefined>;
}): Promise<ComparisonFiles> {
  const base = await loadRun(options.base, 'base');
  const candidate = await loadRun(options.candidate, 'candidate');
  if (base.directory === candidate.directory)
    throw new ComparisonInputError(
      'The base and candidate are the same run; compare two different runs',
    );
  const redactor = await comparisonRedactor(
    [base.directory, candidate.directory],
    options.env ?? process.env,
  );
  const comparison = redactor.deep(compareRuns(base, candidate, options.gate));
  const directory = resolve(
    options.out ??
      join(
        candidate.directory,
        `comparison-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
  );
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (caught) {
    throw new ComparisonInputError(
      `Cannot create the comparison directory ${directory} (it must be new): ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  const json = join(directory, 'comparison.json');
  const html = join(directory, 'comparison.html');
  await writeFile(json, JSON.stringify(comparison, null, 2) + '\n', {
    mode: 0o600,
  });
  await writeFile(html, redactor.text(comparisonHTML(comparison, directory)), {
    mode: 0o600,
  });
  return { comparison, directory, json, html, redactor };
}

// One line per failure or incompatibility, for the terminal.
export function comparisonSummary(comparison: Comparison): string[] {
  if (!comparison.compatible)
    return [
      'COMPARISON INVALID: the runs did not measure the same thing',
      ...comparison.incompatibilities.map(
        (field) =>
          `  ${field.field}: base ${field.base || '?'} · candidate ${field.candidate || '?'} (${field.message})`,
      ),
    ];
  const { counts, gate } = comparison;
  return [
    `Compared: ${counts.new} new, ${counts.persisting} persisting, ${counts.resolved} resolved, ${counts.unassessed} unassessed finding(s); ${counts.coverageLost} check(s) lost coverage`,
    ...comparison.warnings.map(
      (field) => `  warning ${field.field}: ${field.message}`,
    ),
    gate!.passed
      ? `GATE PASSED (fail on ${gate!.config.failOn})`
      : `GATE FAILED (fail on ${gate!.config.failOn}): ${gate!.failures.length} failure(s)`,
    ...gate!.failures.map((failure) => `  ${failure.code}: ${failure.message}`),
  ];
}
