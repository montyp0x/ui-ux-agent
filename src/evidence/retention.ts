// Run directories are created once and never overwritten (runSuite refuses an
// existing directory) and never uploaded: the runner has no upload path.
// Deletion is explicit: pruneRuns deletes only directories carrying this
// tool's run manifest whose retention has passed.
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const RUN_MANIFEST = 'run.json';

export const runManifestSchema = z
  .object({
    tool: z.literal('ui-ux-agent'),
    manifestVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    // Earliest time --prune-runs may delete this run.
    deleteAfter: z.iso.datetime(),
    retentionDays: z.number().int().min(1).max(3650),
    // Never set by the runner: it does not upload evidence.
    uploaded: z.literal(false),
  })
  .strict();
export type RunManifest = z.infer<typeof runManifestSchema>;

// Written first into a new run directory ('wx': never replaces a manifest).
export async function writeRunManifest(
  directory: string,
  retentionDays: number,
  now = new Date(),
): Promise<RunManifest> {
  const manifest: RunManifest = {
    tool: 'ui-ux-agent',
    manifestVersion: 1,
    createdAt: now.toISOString(),
    deleteAfter: new Date(
      now.getTime() + retentionDays * 86400000,
    ).toISOString(),
    retentionDays,
    uploaded: false,
  };
  await writeFile(
    join(directory, RUN_MANIFEST),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return manifest;
}

export type PruneEntry = {
  directory: string;
  action: 'deleted' | 'would_delete' | 'kept' | 'skipped';
  reason: string;
};

// Looks at the direct children of `root`. Deletes (or with dryRun, lists) run
// directories whose manifest's deleteAfter has passed; directories without a
// valid manifest, symlinks and files are skipped and never deleted.
export async function pruneRuns(
  root: string,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<PruneEntry[]> {
  const now = options.now ?? new Date();
  const entries: PruneEntry[] = [];
  for (const name of (await readdir(root)).sort()) {
    const directory = join(root, name);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    let manifest: RunManifest;
    try {
      const raw = await readFile(join(directory, RUN_MANIFEST), 'utf8');
      manifest = runManifestSchema.parse(JSON.parse(raw));
    } catch {
      entries.push({
        directory,
        action: 'skipped',
        reason: `no valid ${RUN_MANIFEST}: not a run directory this tool manages`,
      });
      continue;
    }
    if (new Date(manifest.deleteAfter) > now) {
      entries.push({
        directory,
        action: 'kept',
        reason: `retained until ${manifest.deleteAfter}`,
      });
      continue;
    }
    if (!options.dryRun) await rm(directory, { recursive: true });
    entries.push({
      directory,
      action: options.dryRun ? 'would_delete' : 'deleted',
      reason: `retention ended ${manifest.deleteAfter}`,
    });
  }
  return entries;
}
