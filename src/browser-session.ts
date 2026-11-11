import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { StorageState } from './auth.js';

// Reuse the session a person already has in their everyday Chromium-based
// browser on macOS, so runs need no separate sign-in. Only cookies whose host
// applies to the suite's origins are read and decrypted; nothing else in the
// profile is touched, and values are never logged or written by this module.

type BrowserProfileSource = {
  // Under ~/Library/Application Support.
  userData: string;
  keychainService: string;
  keychainAccount: string;
};

export const browserSources = {
  dia: {
    userData: 'Dia/User Data',
    keychainService: 'Dia Safe Storage',
    keychainAccount: 'Dia',
  },
  chrome: {
    userData: 'Google/Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
} satisfies Record<string, BrowserProfileSource>;
export type BrowserSourceName = keyof typeof browserSources;

export function isBrowserSourceName(value: string): value is BrowserSourceName {
  return Object.hasOwn(browserSources, value);
}

export type BrowserSessionReport = {
  browser: BrowserSourceName;
  profile: string;
  cookies: number;
  hosts: string[];
};

// Chromium's macOS cookie key: PBKDF2 over the Keychain "Safe Storage" secret.
export function chromiumCookieKey(secret: string): Buffer {
  return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
}

// Decrypts one encrypted_value ("v10" + AES-128-CBC). Cookie databases from
// version 24 prefix the plaintext with SHA-256(host_key), which is checked so a
// wrong key or format fails loudly instead of yielding garbage cookies.
export function decryptCookieValue(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string,
  dbVersion: number,
): string {
  const data = Buffer.from(encrypted);
  if (data.length === 0) return '';
  const prefix = data.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10')
    throw new Error(`Unsupported cookie encryption "${prefix}"`);
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([
    decipher.update(data.subarray(3)),
    decipher.final(),
  ]);
  if (dbVersion >= 24) {
    const digest = createHash('sha256').update(hostKey).digest();
    if (!plain.subarray(0, 32).equals(digest))
      throw new Error(`Cookie for ${hostKey} failed the host check`);
    plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

// host_key values that apply to a host: the host itself (host-only cookies)
// and the dotted form of the host and each parent domain (domain cookies).
export function applicableHostKeys(hosts: string[]): string[] {
  const keys = new Set<string>();
  for (const host of hosts.map((value) => value.toLowerCase())) {
    keys.add(host);
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++)
      keys.add(`.${labels.slice(i).join('.')}`);
  }
  return [...keys];
}

// Chromium stores times as microseconds since 1601-01-01.
const chromiumEpochOffsetSeconds = 11644473600;
const sameSite = { 0: 'None', 1: 'Lax', 2: 'Strict' } as const;

type CookieRow = {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  samesite: number | bigint;
};

// Reads the cookies for `hosts` from a Chromium cookie database file.
export function readCookies(
  databasePath: string,
  hosts: string[],
  key: Buffer,
  now = Date.now(),
): StorageState['cookies'] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number(
      (
        db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
          { value: string } | undefined
      )?.value ?? 0,
    );
    const keys = applicableHostKeys(hosts);
    const nowChromium =
      BigInt(Math.floor(now / 1000) + chromiumEpochOffsetSeconds) * 1000000n;
    const select = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
                is_secure, is_httponly, samesite
           FROM cookies
          WHERE host_key IN (${keys.map(() => '?').join(', ')})
            AND (expires_utc = 0 OR expires_utc > ?)`,
    );
    // Chromium timestamps exceed Number.MAX_SAFE_INTEGER.
    select.setReadBigInts(true);
    const rows = select.all(...keys, nowChromium) as CookieRow[];
    return rows.map((row) => {
      const secure = Number(row.is_secure) === 1;
      const expires = BigInt(row.expires_utc);
      const site =
        sameSite[Number(row.samesite) as keyof typeof sameSite] ?? 'Lax';
      return {
        name: row.name,
        value:
          row.value ||
          decryptCookieValue(row.encrypted_value, key, row.host_key, version),
        domain: row.host_key,
        path: row.path,
        expires:
          expires === 0n
            ? -1
            : Number(expires - BigInt(chromiumEpochOffsetSeconds) * 1000000n) /
              1000000,
        httpOnly: Number(row.is_httponly) === 1,
        secure,
        // Chromium drops SameSite=None cookies that are not Secure.
        sameSite: site === 'None' && !secure ? 'Lax' : site,
      };
    });
  } finally {
    db.close();
  }
}

async function keychainSecret(source: BrowserProfileSource): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(
      'security',
      [
        'find-generic-password',
        '-w',
        '-s',
        source.keychainService,
        '-a',
        source.keychainAccount,
      ],
      // macOS may show an allow dialog the first time.
      { timeout: 120000 },
    );
    return stdout.trim();
  } catch (caught) {
    if ((caught as { killed?: boolean }).killed)
      throw new Error(
        `No answer to the Keychain dialog for "${source.keychainService}" within 120s; choose Always Allow to stop it asking each run`,
      );
    const detail = String(
      (caught as { stderr?: string }).stderr || (caught as Error).message,
    ).trim();
    throw new Error(
      `Could not read "${source.keychainService}" from the Keychain (denied or missing): ${detail}`,
    );
  }
}

// The scoped session for `hosts` from a browser profile on this Mac.
export async function importBrowserSession(
  browser: BrowserSourceName,
  hosts: string[],
  profile = 'Default',
): Promise<{ state: StorageState; report: BrowserSessionReport }> {
  if (process.platform !== 'darwin')
    throw new Error('--from-browser is supported on macOS only');
  const source = browserSources[browser];
  const profileDir = join(
    homedir(),
    'Library/Application Support',
    source.userData,
    profile,
  );
  const cookieFile = join(profileDir, 'Cookies');
  if (!existsSync(cookieFile))
    throw new Error(`No cookie store for ${browser} profile "${profile}"`);
  const key = chromiumCookieKey(await keychainSecret(source));
  // The running browser holds the database open; read a private copy.
  const work = await mkdtemp(join(tmpdir(), 'uiux-session-'));
  try {
    const copy = join(work, 'Cookies');
    await copyFile(cookieFile, copy);
    for (const suffix of ['-wal', '-journal'])
      if (existsSync(cookieFile + suffix))
        await copyFile(cookieFile + suffix, copy + suffix);
    const cookies = readCookies(copy, hosts, key);
    return {
      state: { cookies, origins: [] },
      report: { browser, profile, cookies: cookies.length, hosts },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
