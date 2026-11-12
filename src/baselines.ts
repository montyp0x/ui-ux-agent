// Explicit baseline operations: approving reviewed captures from a finished
// run into the user's baseline directory, and listing what is approved.
// Nothing else writes baselines; a run only reads them.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseResults, type Result } from './results.js';
import { RUN_MANIFEST, runManifestSchema } from './evidence/retention.js';
import {
  BASELINE_METADATA_VERSION,
  baselineDirectory,
  baselineFiles,
  baselineMetadataSchema,
  imageOf,
  readBaselines,
  sha256,
  type BaselineMetadata,
} from './audits/visual.js';
import type { VisualComparison, VisualKey } from './audits/visual-contract.js';

const run = promisify(execFile);

function gitWorkTree(path: string): string | null {
  for (let directory = path; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

// Baselines are evidence: kept out of Git. A directory inside a Git work tree
// is accepted only when Git ignores it (for example .baselines/ in this
// repository's .gitignore).
export async function assertOutsideGit(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const tree = gitWorkTree(absolute);
  if (!tree) return;
  try {
    // Exit 0: ignored. A trailing slash asks about the directory itself.
    await run('git', ['-C', tree, 'check-ignore', '-q', `${absolute}${sep}`], {
      timeout: 10000,
    });
  } catch {
    throw new Error(
      `Baseline directory ${absolute} is inside the Git work tree ${tree} and not ignored by Git; use a directory outside Git or an ignored one (for example .baselines/)`,
    );
  }
}

// Baselines outlive runs: a baseline directory inside a run directory (one
// carrying this tool's run manifest) would be deleted with that run by
// --prune-runs, so it is refused.
export async function assertOutsideRunDirectory(
  directory: string,
): Promise<void> {
  for (let path = resolve(directory); ; path = dirname(path)) {
    let manifest: unknown = null;
    try {
      manifest = JSON.parse(await readFile(join(path, RUN_MANIFEST), 'utf8'));
    } catch {
      // No readable manifest here: not a run directory.
    }
    if (manifest !== null && runManifestSchema.safeParse(manifest).success)
      throw new Error(
        `Baseline directory ${resolve(directory)} is inside the run directory ${path}, which --prune-runs deletes when its retention ends; keep baselines outside run directories`,
      );
    if (dirname(path) === path) return;
  }
}

// The baseline directory a run reads: it must exist, stay out of Git and
// outside every run directory.
export async function baselineDirectoryForRun(
  directory: string,
): Promise<string> {
  const absolute = resolve(directory);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(
      `Baseline directory ${absolute} does not exist; create it, or approve captures into it with npm run baseline -- approve`,
    );
  }
  if (!info.isDirectory())
    throw new Error(`Baseline path ${absolute} is not a directory`);
  await assertOutsideGit(absolute);
  await assertOutsideRunDirectory(absolute);
  return absolute;
}

export type ApproveOptions = {
  // A run directory (with results.json) or a results.json path.
  run: string;
  baselines: string;
  journey?: string;
  viewport?: string;
  checkpoint?: string;
  // Approve every capture in the run that the filters select; required when
  // no filter is given, so nothing is approved by accident.
  all?: boolean;
  // Replace an approved baseline the capture differs from (an update).
  replace?: boolean;
  // Approve captures from runs whose functional outcome did not pass.
  allowFailedRuns?: boolean;
};

export type ApprovalDecision = {
  key: VisualKey;
  attempt: number;
  status: VisualComparison['status'];
  action: 'created' | 'replaced' | 'skipped';
  reason: string;
  file: string | null;
};

export const visualKeyText = (key: VisualKey) =>
  `${key.journey}/${key.viewport}/${key.checkpoint}`;

function inside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return !!path && !path.startsWith('..') && !path.startsWith(sep);
}

// A token the evidence redactor leaves in place of a match.
const REDACTED = /\[REDACTED(?::[^\]\s]*)?\]/;

// Every PNG under the run directory (symlinks not followed), by SHA-256.
function lazyChecksumIndex(
  runDirectory: string,
): () => Promise<Map<string, string>> {
  let index: Promise<Map<string, string>> | null = null;
  const build = async () => {
    const found = new Map<string, string>();
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith('.png'))
          found.set(sha256(await readFile(path)), path);
      }
    };
    await walk(runDirectory);
    return found;
  };
  return () => (index ??= build());
}

// The capture a visual record names. results.json is redacted text, so a
// suite pattern or secret value can rewrite the recorded path (a user name
// in a home directory, for example); the image bytes are never redacted, so
// the capture is then found by the checksum the run recorded, inside the
// run directory only.
async function locateCapture(
  runDirectory: string,
  current: { file: string; sha256: string },
  byChecksum: () => Promise<Map<string, string>>,
): Promise<
  | { status: 'found'; png: Buffer; file: string }
  | { status: 'skipped'; reason: string }
> {
  const recorded = resolve(runDirectory, current.file);
  let changed = false;
  if (!REDACTED.test(current.file) && inside(runDirectory, recorded)) {
    try {
      const png = await readFile(recorded);
      if (sha256(png) === current.sha256)
        return { status: 'found', png, file: recorded };
      changed = true;
    } catch {
      // Missing at the recorded path: look it up by checksum.
    }
  }
  const file = (await byChecksum()).get(current.sha256);
  if (file) return { status: 'found', png: await readFile(file), file };
  if (changed)
    return {
      status: 'skipped',
      reason: `the capture ${recorded} changed after the run recorded it`,
    };
  if (!REDACTED.test(current.file) && !inside(runDirectory, recorded))
    return {
      status: 'skipped',
      reason: `the capture ${recorded} is outside the run directory`,
    };
  return {
    status: 'skipped',
    reason: `the capture ${current.file} is missing from the run directory`,
  };
}

async function writeAtomically(path: string, data: Buffer | string) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

// Approves reviewed captures. Each selected comparison's current image is
// verified against the checksum the run recorded, then written with its
// environment as the baseline for that environment. A capture that already
// matches, did not settle, or differs from an approved baseline without
// --replace is skipped with the reason.
export async function approveBaselines(
  options: ApproveOptions,
): Promise<ApprovalDecision[]> {
  const filtered = !!(
    options.journey ||
    options.viewport ||
    options.checkpoint
  );
  if (!filtered && !options.all)
    throw new Error(
      'Select captures to approve with --journey, --viewport and/or --checkpoint, or pass --all after reviewing every one',
    );
  const input = resolve(options.run);
  const resultsPath = (await stat(input)).isDirectory()
    ? join(input, 'results.json')
    : input;
  const runDirectory = dirname(resultsPath);
  const results: Result[] = parseResults(await readFile(resultsPath, 'utf8'));
  const root = resolve(options.baselines);
  await assertOutsideGit(root);
  await assertOutsideRunDirectory(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const decisions: ApprovalDecision[] = [];
  // One approval per baseline file: the first selected capture wins and later
  // repetitions of the same key and environment are skipped.
  const written = new Set<string>();
  // Built on first use: every PNG in the run directory by checksum.
  const capturesByChecksum = lazyChecksumIndex(runDirectory);
  for (const result of results)
    for (const auditRun of result.audits.runs) {
      const visual = auditRun.visual;
      if (!visual) continue;
      const { key } = visual;
      if (
        (options.journey && key.journey !== options.journey) ||
        (options.viewport && key.viewport !== options.viewport) ||
        (options.checkpoint && key.checkpoint !== options.checkpoint)
      )
        continue;
      const decide = (
        action: ApprovalDecision['action'],
        reason: string,
        file: string | null = null,
      ) =>
        decisions.push({
          key,
          attempt: result.attempt,
          status: visual.status,
          action,
          reason,
          file,
        });
      // The suite's redaction rewrote the key in results.json: approving it
      // would file the baseline where no run looks for it.
      if (REDACTED.test(key.suite)) {
        decide(
          'skipped',
          "the suite name in this run's results was redacted by the suite's evidence patterns, so the baseline location is unknown; rename the suite or narrow the pattern",
        );
        continue;
      }
      if (result.status !== 'passed' && !options.allowFailedRuns) {
        decide(
          'skipped',
          `the run's functional outcome was ${result.status} (${result.outcome.code}); pass --allow-failed-runs to approve its captures`,
        );
        continue;
      }
      if (!visual.current) {
        decide('skipped', 'the page did not settle, so there is no capture');
        continue;
      }
      if (visual.status === 'match') {
        decide('skipped', 'already matches the approved baseline');
        continue;
      }
      const files = baselineFiles(root, key, visual.environmentId);
      const exists = existsSync(files.json) || existsSync(files.png);
      if (written.has(files.png)) {
        decide(
          'skipped',
          'an earlier capture in this run was approved for the same baseline',
        );
        continue;
      }
      if (exists && !options.replace) {
        decide(
          'skipped',
          visual.status === 'mismatch'
            ? 'differs from the approved baseline; pass --replace to update it'
            : 'a baseline for this environment was approved after this run; pass --replace to update it',
        );
        continue;
      }
      const found = await locateCapture(
        runDirectory,
        visual.current,
        capturesByChecksum,
      );
      if (found.status !== 'found') {
        decide('skipped', found.reason);
        continue;
      }
      const { png } = found;
      const image = imageOf(files.png, png);
      const metadata: BaselineMetadata = baselineMetadataSchema.parse({
        version: BASELINE_METADATA_VERSION,
        key,
        environmentId: visual.environmentId,
        environment: visual.environment,
        image: {
          width: image.width,
          height: image.height,
          sha256: image.sha256,
        },
        approvedAt: new Date().toISOString(),
        maskedRegions: visual.maskedRegions,
        source: { results: resultsPath, attempt: result.attempt },
      });
      await mkdir(baselineDirectory(root, key), {
        recursive: true,
        mode: 0o700,
      });
      await writeAtomically(files.png, png);
      await writeAtomically(
        files.json,
        JSON.stringify(metadata, null, 2) + '\n',
      );
      written.add(files.png);
      decide(
        exists ? 'replaced' : 'created',
        exists
          ? `updated the baseline for this environment (was ${visual.status})`
          : `new baseline for this environment (was ${visual.status})`,
        files.png,
      );
    }
  return decisions;
}

export type ListedBaseline = BaselineMetadata & { file: string };

// Every approved baseline under the directory.
export async function listBaselines(
  directory: string,
): Promise<ListedBaseline[]> {
  const root = resolve(directory);
  const out: ListedBaseline[] = [];
  const walk = async (path: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw caught;
    }
    if (depth === 4) {
      const metadata = entries.find((entry) => entry.name.endsWith('.json'));
      if (!metadata) return;
      const parsed = baselineMetadataSchema.parse(
        JSON.parse(await readFile(join(path, metadata.name), 'utf8')),
      );
      for (const entry of await readBaselines(root, parsed.key))
        out.push({
          ...entry,
          file: baselineFiles(root, entry.key, entry.environmentId).png,
        });
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory()) await walk(join(path, entry.name), depth + 1);
  };
  await walk(root, 0);
  return out;
}
