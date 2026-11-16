// Report links to evidence files whose recorded path the run's redaction
// rewrote. Results are redacted text: when a secret is part of a recorded path
// (a secret value in the run directory's path, a journey or viewport name a
// suite pattern matches), the path in results.json no longer names a file.
// The report must still link the file without printing the secret, so:
//
// - a path under a known root (the run directory, the baseline directory)
//   whose redacted part is only the root itself is linked by its path
//   relative to the run directory;
// - a path redacted below the root is matched against the files under that
//   root (each file's own path, redacted the same way), and the single file it
//   names is linked through an alias in the run directory,
//   `evidence-links/<sha256 of its content, 16 hex>.<ext>`: a hard link for
//   files inside the run (no copy, removed with the run), a private copy for
//   files outside it. The alias name carries no part of the secret path.
//
// A redacted path that names no file, or several, is not linked
// (UNRESOLVED_LINK) rather than guessed.
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
} from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Redactor } from './redact.js';
import { makePrivate } from './private.js';

export const LINK_DIRECTORY = 'evidence-links';
// An in-page anchor: no file, no secret.
export const UNRESOLVED_LINK = '#evidence-path-redacted';
const TOKEN = /\[REDACTED(?::[^\]\s]*)?\]/;

const href = (path: string) => path.split(sep).join('/');

// Every file under `root` by its relative path, symlinks not followed and
// existing aliases skipped.
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (!prefix && name === LINK_DIRECTORY) continue;
      const path = join(dir, name);
      const rel = prefix ? join(prefix, name) : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path, rel);
      else if (info.isFile()) found.push(rel);
    }
  };
  await walk(root, '');
  return found;
}

// Resolves the files a report shows (recorded, redacted paths) to hrefs
// relative to the run directory `directory`. `roots` are other directories
// evidence may live in (the baseline directory).
export async function evidenceLinks(
  directory: string,
  redactor: Redactor,
  files: Iterable<string>,
  roots: readonly string[] = [],
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  // Longest first, so a root inside another wins.
  const known = [directory, ...roots]
    .filter((root, index, all) => all.indexOf(root) === index)
    .sort((a, b) => b.length - a.length);
  const indexes = new Map<string, Promise<Map<string, string[]>>>();
  const index = (root: string) => {
    let built = indexes.get(root);
    if (!built) {
      built = filesUnder(root).then((paths) => {
        const byRedacted = new Map<string, string[]>();
        for (const path of paths) {
          const key = redactor.text(path);
          byRedacted.set(key, [...(byRedacted.get(key) ?? []), path]);
        }
        return byRedacted;
      });
      indexes.set(root, built);
    }
    return built;
  };
  const alias = async (real: string, inside: boolean): Promise<string> => {
    const digest = createHash('sha256')
      .update(await readFile(real))
      .digest('hex')
      .slice(0, 16);
    const extension = extname(real).toLowerCase();
    const name = `${digest}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ''}`;
    const folder = join(directory, LINK_DIRECTORY);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const target = join(folder, name);
    try {
      await lstat(target);
    } catch {
      // A hard link shares the file (and its later redaction) without a
      // copy; a file outside the run is copied, so the run's permission pass
      // never changes the original.
      if (inside) {
        try {
          await link(real, target);
        } catch {
          await copyFile(real, target);
        }
      } else await copyFile(real, target);
      await makePrivate(target, 'file');
    }
    return `${LINK_DIRECTORY}/${name}`;
  };
  const resolveOne = async (file: string): Promise<string> => {
    if (!TOKEN.test(file)) return href(relative(directory, file));
    for (const root of known) {
      const prefix = [root, redactor.text(root)].find(
        (candidate) => file === candidate || file.startsWith(candidate + sep),
      );
      if (prefix === undefined) continue;
      const rest = file.slice(prefix.length + 1);
      const inside = root === directory;
      let real: string;
      if (!TOKEN.test(rest)) real = join(root, rest);
      else {
        const matches = (await index(root)).get(rest) ?? [];
        if (matches.length !== 1) return UNRESOLVED_LINK;
        real = join(root, matches[0]!);
      }
      try {
        if (!(await lstat(real)).isFile()) return UNRESOLVED_LINK;
      } catch {
        return UNRESOLVED_LINK;
      }
      const path = href(relative(directory, real));
      // A path that would print a secret (a file outside the run whose
      // location holds it) goes through an alias as well.
      return !TOKEN.test(rest) && (inside || !redactor.matches(path))
        ? path
        : alias(real, inside);
    }
    return UNRESOLVED_LINK;
  };
  for (const file of files)
    if (!links.has(file)) links.set(file, await resolveOne(file));
  return links;
}
