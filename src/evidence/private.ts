// Evidence, sessions and baselines are private to the user who ran the tool.
//
// On POSIX that is mode 0600 for files and 0700 for directories. Windows
// ignores those mode bits (only the read-only flag maps to them), so a file
// there keeps whatever access its parent folder grants: a run directory
// under C:\runs would be readable by every user of the machine. On Windows
// the path instead gets a protected ACL (no inherited entries) that grants
// full control to the current user, SYSTEM and Administrators only, the
// equivalent of 0600/0700 (root can still read those on POSIX). Files and
// directories created inside a private directory inherit its ACL.
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WINDOWS = process.platform === 'win32';
// By full path: under Git Bash or MSYS, PATH finds GNU coreutils' whoami first.
const system32 = (tool: string) =>
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);

// LocalSystem and BUILTIN\Administrators, as SIDs (names are localized).
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';

// The SID an SDDL trustee names. SDDL writes well-known SIDs as aliases;
// the machine's built-in Administrator and Guest accounts (RID 500 and 501:
// on Azure VMs, GitHub's Windows runners included, the admin account is the
// renamed built-in Administrator) are aliased relative to the machine, whose
// prefix the user's own SID gives.
function trusteeSid(trustee: string, user: string): string {
  if (trustee === 'SY') return SYSTEM_SID;
  if (trustee === 'BA') return ADMINISTRATORS_SID;
  const machine = /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(user)?.[1];
  if (machine && trustee === 'LA') return `${machine}-500`;
  if (machine && trustee === 'LG') return `${machine}-501`;
  return trustee;
}

let userSid: Promise<string> | null = null;

// The SID of the user running this process (Windows only).
export function currentUserSid(): Promise<string> {
  userSid ??= run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    timeout: 10000,
    windowsHide: true,
  }).then(({ stdout }) => {
    const sid = /"(S-1-[0-9-]+)"/.exec(stdout)?.[1];
    if (!sid) throw new Error('whoami /user did not report a SID');
    return sid;
  });
  return userSid;
}

// Makes `path` private to the current user (see above).
export async function makePrivate(
  path: string,
  kind: 'file' | 'directory',
): Promise<void> {
  if (!WINDOWS) {
    await chmod(path, kind === 'directory' ? 0o700 : 0o600);
    return;
  }
  // (OI)(CI): files and directories created inside inherit the grant.
  const rights = kind === 'directory' ? '(OI)(CI)F' : 'F';
  const sid = await currentUserSid();
  await run(
    system32('icacls.exe'),
    [
      path,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:${rights}`,
      `*${SYSTEM_SID}:${rights}`,
      `*${ADMINISTRATORS_SID}:${rights}`,
      '/q',
    ],
    { timeout: 10000, windowsHide: true },
  );
}

// Whether a Windows security descriptor (SDDL) grants access only to `user`,
// SYSTEM and Administrators. Inherited entries count: a file inside a private
// directory is private through them.
export function sddlIsPrivate(sddl: string, user: string): boolean {
  // A null DACL grants everyone everything.
  if (sddl.includes('D:NO_ACCESS_CONTROL')) return false;
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) return false;
  const allowed = new Set([user, SYSTEM_SID, ADMINISTRATORS_SID]);
  const entries = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((match) =>
    match[1]!.split(';'),
  );
  return entries.every((fields) => {
    const [type, , , , , trustee] = fields;
    // Deny entries never widen access.
    if (type === 'D') return true;
    return allowed.has(trusteeSid(trustee ?? '', user));
  });
}

// The security descriptor of `path` as SDDL (Windows only).
export async function windowsAcl(path: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'ui-ux-acl-'));
  try {
    const out = join(folder, 'acl.txt');
    await run(system32('icacls.exe'), [path, '/save', out, '/q'], {
      timeout: 10000,
      windowsHide: true,
    });
    // icacls writes UTF-16LE: the path's name, then its SDDL.
    return (await readFile(out, 'utf16le')).split(/\r?\n/)[1] ?? '';
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// Whether only the current user (and, on Windows, SYSTEM and Administrators)
// can access `path`.
export async function isPrivate(
  path: string,
  kind: 'file' | 'directory',
): Promise<boolean> {
  if (!WINDOWS)
    return ((await stat(path)).mode & 0o777) === (kind === 'directory' ? 0o700 : 0o600);
  return sddlIsPrivate(await windowsAcl(path), await currentUserSid());
}
