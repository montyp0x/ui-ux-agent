import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Suite } from './contracts.js';

// Playwright storage-state file shape, parsed at the boundary. Unknown cookie
// fields are kept so a scoped file round-trips everything Playwright wrote.
const cookieSchema = z
  .object({ name: z.string(), domain: z.string() })
  .passthrough();
export const storageStateSchema = z.object({
  cookies: z.array(cookieSchema),
  origins: z.array(
    z
      .object({
        origin: z.string(),
        localStorage: z.array(
          z.object({ name: z.string(), value: z.string() }),
        ),
      })
      .passthrough(),
  ),
});
export type StorageState = z.infer<typeof storageStateSchema>;

export type ScopeReport = {
  keptCookies: number;
  droppedCookies: Record<string, number>;
  keptOrigins: string[];
  droppedOrigins: string[];
};

// Every origin the suite declares: navigation, backend and request-rule origins.
export function suiteOrigins(suite: Suite): string[] {
  return [
    ...new Set(
      [
        suite.baseURL,
        ...suite.allowedOrigins,
        ...suite.applicationOrigins,
        ...suite.allowedRequests.map((rule) => rule.origin),
        ...suite.readOnlyPosts.map((rule) => rule.origin),
      ].map((value) => new URL(value).origin),
    ),
  ];
}

// A cookie applies to a host when its domain is the host or a parent domain.
function cookieApplies(domain: string, hosts: string[]): boolean {
  const bare = domain.replace(/^\./, '').toLowerCase();
  return hosts.some((host) => host === bare || host.endsWith(`.${bare}`));
}

// Keeps only session material for the suite's origins, so a login captured in
// a browser that also holds other identities (SSO providers, personal accounts)
// does not carry them into test runs and their traces.
export function scopeStorageState(
  state: StorageState,
  origins: string[],
): { state: StorageState; report: ScopeReport } {
  const hosts = origins.map((origin) => new URL(origin).hostname.toLowerCase());
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  const droppedCookies: Record<string, number> = {};
  const cookies = state.cookies.filter((cookie) => {
    if (cookieApplies(cookie.domain, hosts)) return true;
    const domain = cookie.domain.replace(/^\./, '');
    droppedCookies[domain] = (droppedCookies[domain] ?? 0) + 1;
    return false;
  });
  const kept = state.origins.filter((entry) =>
    allowed.has(new URL(entry.origin).origin),
  );
  return {
    state: { cookies, origins: kept },
    report: {
      keptCookies: cookies.length,
      droppedCookies,
      keptOrigins: kept.map((entry) => entry.origin),
      droppedOrigins: state.origins
        .filter((entry) => !kept.includes(entry))
        .map((entry) => entry.origin),
    },
  };
}

// Written into every persistent profile the runner creates. A non-empty
// directory without it was made by something else, such as a browser.
export const PROFILE_MARKER = '.ui-ux-agent-profile';

// Where browsers keep their users' own profiles. A persistent test profile
// may not live there: the runner never opens a personal browser profile.
const PERSONAL_PROFILE_ROOTS = [
  ['Library', 'Application Support'],
  ['Library', 'Containers'],
  ['Library', 'Group Containers'],
  ['.config'],
  ['.mozilla'],
  ['snap'],
  ['.var', 'app'],
];

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
};

// Resolves --profile to a dedicated test profile directory, creating it (mode
// 0700, with PROFILE_MARKER) when missing. Rejects a directory inside a
// browser's own data location, and an existing non-empty directory the runner
// did not create, so a personal profile is never used, copied or modified.
export async function dedicatedProfile(
  path: string,
  home = homedir(),
): Promise<string> {
  const absolute = resolve(path);
  const real = await realpath(absolute).catch(() => absolute);
  const homes = [
    resolve(home),
    await realpath(home).catch(() => resolve(home)),
  ];
  for (const candidate of new Set([absolute, real]))
    for (const base of homes)
      for (const root of PERSONAL_PROFILE_ROOTS)
        if (inside(candidate, join(base, ...root)))
          throw new Error(
            `Refusing profile ${absolute}: it is inside ${join(base, ...root)}, where browsers keep personal profiles. Use a dedicated directory such as .auth/profiles/NAME and sign in with --sign-in.`,
          );
  const entries = await readdir(real).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (entries && entries.length && !entries.includes(PROFILE_MARKER))
    throw new Error(
      `Refusing profile ${absolute}: it is not empty and was not created by this runner (no ${PROFILE_MARKER}). Use a new directory and sign in with --sign-in.`,
    );
  if (!entries?.includes(PROFILE_MARKER)) {
    await mkdir(real, { recursive: true, mode: 0o700 });
    await writeFile(
      join(real, PROFILE_MARKER),
      'Dedicated ui-ux-agent test profile. Not a personal browser profile.\n',
      { mode: 0o600, flag: 'wx' },
    );
  }
  return absolute;
}
