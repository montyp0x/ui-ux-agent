// Text files in a run directory that the runner did not write itself (audit
// measurement files, the native accessibility-tree trace, anything a driver
// adds) get the same redaction before the run is reported. Binary formats
// (images, traces, videos) are not touched: screenshots are masked before
// capture, and traces and videos are governed by the evidence policy.
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Redactor } from './redact.js';

const TEXT = new Set([
  '.json',
  '.jsonl',
  '.html',
  '.txt',
  '.log',
  '.md',
  '.csv',
]);

// The redacted text of one JSON document, or the original when nothing in it
// needs redaction (formatting is kept). Escaped characters are compared after
// parsing, so a secret written with JSON escapes is still found.
function redactJSON(text: string, redactor: Redactor, indent?: number): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return redactor.text(text);
  }
  const redacted = redactor.deep(value);
  return JSON.stringify(redacted) === JSON.stringify(value)
    ? text
    : JSON.stringify(redacted, null, indent);
}

// Redacts every text file under `directory` (symlinks are never followed),
// skipping the paths in `skip`. Returns the paths it rewrote.
export async function sanitizeTextFiles(
  directory: string,
  redactor: Redactor,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const rewritten: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      if (skip.has(path)) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      const extension = extname(name).toLowerCase();
      if (!info.isFile() || !TEXT.has(extension)) continue;
      const original = await readFile(path, 'utf8');
      const redacted =
        extension === '.json'
          ? redactJSON(original, redactor, 2)
          : extension === '.jsonl'
            ? original
                .split('\n')
                .map((line) => (line ? redactJSON(line, redactor) : line))
                .join('\n')
            : redactor.text(original);
      if (redacted !== original) {
        await writeFile(path, redacted, { mode: info.mode & 0o777 });
        rewritten.push(path);
      }
    }
  };
  await walk(directory);
  return rewritten;
}
