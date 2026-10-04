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
