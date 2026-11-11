import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  applicableHostKeys,
  chromiumCookieKey,
  decryptCookieValue,
  isBrowserSourceName,
  readCookies,
} from '../src/browser-session.js';

const key = chromiumCookieKey('test-secret');

// Encrypts like Chromium on macOS; version >= 24 prefixes SHA-256(host_key).
function encrypt(value: string, hostKey: string, version = 24): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([
    version >= 24 ? createHash('sha256').update(hostKey).digest() : Buffer.of(),
    Buffer.from(value),
  ]);
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(plain),
    cipher.final(),
  ]);
}

const toChromium = (unixSeconds: number) =>
  BigInt(unixSeconds + 11644473600) * 1000000n;

test('decrypts v10 values and checks the host digest', () => {
  assert.equal(
    decryptCookieValue(encrypt('abc', '.example.com'), key, '.example.com', 24),
    'abc',
  );
  assert.equal(
    decryptCookieValue(encrypt('old', 'x.test', 23), key, 'x.test', 23),
    'old',
  );
  assert.throws(
    () =>
      decryptCookieValue(encrypt('abc', '.other.com'), key, '.example.com', 24),
    /host check/,
  );
  assert.throws(
    () => decryptCookieValue(Buffer.from('v11xxxx'), key, 'a.test', 24),
    /Unsupported/,
  );
  assert.equal(decryptCookieValue(Buffer.of(), key, 'a.test', 24), '');
});

test('host keys cover the host and its parent domains, never a bare TLD', () => {
  assert.deepEqual(applicableHostKeys(['App.Example.com']).sort(), [
    '.app.example.com',
    '.example.com',
    'app.example.com',
  ]);
});

test('reads only live cookies for the requested hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cookies-test-'));
  try {
    const file = join(dir, 'Cookies');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
      INSERT INTO meta VALUES ('version', '24');
      CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT,
        encrypted_value BLOB, path TEXT, expires_utc INTEGER,
        is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);`);
    const insert = db.prepare(
      'INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const now = Date.UTC(2026, 0, 1);
    const later = toChromium(now / 1000 + 3600);
    insert.run(
      '.example.com',
      'session',
      '',
      encrypt('s1', '.example.com'),
      '/',
      later,
      1,
      1,
      0,
    );
    insert.run(
      'app.example.com',
      'host',
      '',
      encrypt('h1', 'app.example.com'),
      '/',
      0,
      0,
      0,
      -1,
    );
    insert.run(
      'other.example.com',
      'sibling',
      '',
      encrypt('x', 'other.example.com'),
      '/',
      later,
      1,
      0,
      1,
    );
    insert.run(
      '.example.com',
      'expired',
      '',
      encrypt('e', '.example.com'),
      '/',
      toChromium(now / 1000 - 1),
      1,
      0,
      1,
    );
    insert.run(
      '.elsewhere.test',
      'foreign',
      '',
      encrypt('f', '.elsewhere.test'),
      '/',
      later,
      1,
      0,
      1,
    );
    insert.run(
      '.example.com',
      'plain',
      'p1',
      Buffer.of(),
      '/a',
      later,
      0,
      0,
      0,
    );
    db.close();

    const cookies = readCookies(file, ['app.example.com'], key, now);
    assert.deepEqual(cookies.map((c) => c.name).sort(), [
      'host',
      'plain',
      'session',
    ]);
    const named = (name: string) => {
      const found = cookies.find((c) => c.name === name);
      assert.ok(found, name);
      return found;
    };
    const byName = {
      session: named('session'),
      host: named('host'),
      plain: named('plain'),
    };
    assert.equal(byName.session.value, 's1');
    assert.equal(byName.session.sameSite, 'None');
    assert.equal(byName.session.httpOnly, true);
    assert.equal(byName.session.expires, now / 1000 + 3600);
    assert.equal(byName.host.value, 'h1');
    assert.equal(byName.host.expires, -1);
    assert.equal(byName.host.sameSite, 'Lax');
    // SameSite=None without Secure is not something Chromium would send.
    assert.equal(byName.plain.sameSite, 'Lax');
    assert.equal(byName.plain.value, 'p1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only known browsers are accepted', () => {
  assert.equal(isBrowserSourceName('dia'), true);
  assert.equal(isBrowserSourceName('toString'), false);
  assert.equal(isBrowserSourceName('firefox'), false);
});
