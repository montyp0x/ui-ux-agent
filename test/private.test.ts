import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  currentUserSid,
  isPrivate,
  makePrivate,
  sddlIsPrivate,
  windowsAcl,
} from '../src/evidence/private.js';

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';

test('a Windows ACL is private only when every allow entry is the user, SYSTEM or Administrators', () => {
  // What makePrivate sets on a directory, and what a file inside inherits.
  assert.ok(
    sddlIsPrivate(
      `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`,
      USER,
    ),
  );
  assert.ok(
    sddlIsPrivate(
      `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;S-1-5-32-544)(A;ID;FA;;;${USER})`,
      USER,
    ),
  );
  // The machine's built-in Administrator (RID 500, the admin account of
  // Azure VMs and GitHub's Windows runners) is written as LA, and only it.
  const ADMIN = 'S-1-5-21-1111111111-2222222222-3333333333-500';
  assert.ok(
    sddlIsPrivate('D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', ADMIN),
  );
  assert.ok(!sddlIsPrivate(`D:P(A;;FA;;;${USER})(A;;FA;;;LA)`, USER));
  assert.ok(!sddlIsPrivate(`D:P(A;;FA;;;${ADMIN})(A;;FA;;;LG)`, ADMIN));
  // A deny entry never widens access.
  assert.ok(sddlIsPrivate(`D:P(D;;FA;;;WD)(A;;FA;;;${USER})`, USER));
  // Inherited read access for Users or Authenticated Users (C:\ and its new
  // folders), another account, or everyone.
  assert.ok(
    !sddlIsPrivate(`D:AI(A;ID;FA;;;${USER})(A;OICIID;0x1200a9;;;BU)`, USER),
  );
  assert.ok(!sddlIsPrivate(`D:AI(A;ID;FA;;;${USER})(A;ID;0x1301bf;;;AU)`, USER));
  assert.ok(
    !sddlIsPrivate(
      `D:P(A;;FA;;;${USER})(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1002)`,
      USER,
    ),
  );
  assert.ok(!sddlIsPrivate(`D:P(A;;FA;;;${USER})(A;;FR;;;WD)`, USER));
  // A null DACL grants everyone everything; a missing one is unknown.
  assert.ok(!sddlIsPrivate('O:BAG:SYD:NO_ACCESS_CONTROL', USER));
  assert.ok(!sddlIsPrivate('O:BAG:SY', USER));
});

test('makePrivate makes a directory and everything later created in it private', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ui-ux-private-'));
  // On Windows a failure shows the ACL it read, and the user it checked for.
  const why = async (path: string) =>
    process.platform === 'win32'
      ? `${path}: ${await windowsAcl(path)} (user ${await currentUserSid()})`
      : path;
  const assertPrivate = async (path: string, kind: 'file' | 'directory') =>
    assert.ok(await isPrivate(path, kind), await why(path));
  try {
    const directory = join(base, 'run');
    await mkdir(directory);
    await makePrivate(directory, 'directory');
    await mkdir(join(directory, 'journey'));
    await writeFile(join(directory, 'journey', 'events.jsonl'), '{}\n');
    await assertPrivate(directory, 'directory');
    // On Windows what is created inside inherits the directory's ACL. On
    // POSIX new entries follow the umask; the runner creates its own with
    // explicit modes and the final permission pass covers the rest.
    if (process.platform === 'win32') {
      await assertPrivate(join(directory, 'journey'), 'directory');
      await assertPrivate(join(directory, 'journey', 'events.jsonl'), 'file');
    }
    const file = join(base, 'session.json');
    await writeFile(file, '{}');
    await makePrivate(file, 'file');
    await assertPrivate(file, 'file');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
