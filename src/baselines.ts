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

// The baseline directory a run reads: it must exist, and stay out of Git.
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
  await mkdir(root, { recursive: true, mode: 0o700 });
  const decisions: ApprovalDecision[] = [];
  // One approval per baseline file: the first selected capture wins and later
  // repetitions of the same key and environment are skipped.
  const written = new Set<string>();
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
      const current = resolve(runDirectory, visual.current.file);
      if (!inside(runDirectory, current)) {
        decide(
          'skipped',
          `the capture ${current} is outside the run directory`,
        );
        continue;
      }
      let png: Buffer;
      try {
        png = await readFile(current);
      } catch {
        decide('skipped', `the capture ${current} is missing`);
        continue;
      }
      if (sha256(png) !== visual.current.sha256) {
        decide(
          'skipped',
          `the capture ${current} changed after the run recorded it`,
        );
        continue;
      }
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
