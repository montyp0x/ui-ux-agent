import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { suiteSchema } from '../src/contracts.js';
import {
  evidencePolicySchema,
  evidenceFormats,
} from '../src/evidence/policy.js';
import { evidenceProtection } from '../src/evidence/protection.js';
import { Redactor, credentialEnvValues } from '../src/evidence/redact.js';
import { protectedScreenshot } from '../src/drivers/playwright-evidence.js';
import { pixelCounts } from './evidence-fixtures.js';

// Planted fixture secrets. None is a real credential.
const SUITE_SECRET = 'ACME-CASE-482913';
const ENV_SECRET = 'fixture-env-password-7731';
const API_KEY = 'sk-fixture0000000000000000abcd';

test('the redactor removes suite patterns, environment credentials and built-in credential shapes', () => {
  const redactor = new Redactor({
    patterns: [{ pattern: 'ACME-CASE-\\d{6}', label: 'case-id' }],
    envNames: ['APP_LOGIN'],
    env: {
      APP_LOGIN: ENV_SECRET,
      PLANNER_API_KEY: 'planner-key-fixture-1',
      // Discovered by name; too short ones are ignored.
      SHORT_TOKEN: 'abc',
      HOME: '/Users/somebody',
      PLANNER_API_HEADERS: JSON.stringify({ 'X-Gateway-Key': 'gw-fixture-99' }),
    },
  });
  const text = [
    `Case ${SUITE_SECRET} opened`,
    `typed ${ENV_SECRET} into the form`,
    'key planner-key-fixture-1 and gw-fixture-99',
    `Authorization: Bearer abcdefghijklmnop`,
    `key=${API_KEY}`,
    'https://user:hunter22@example.test/path?access_token=tok123&page=2',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlMTIz',
    'password: hunter2!',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'abc stays, /Users/somebody stays',
  ].join('\n');
  const out = redactor.text(text);
  for (const secret of [
    SUITE_SECRET,
    ENV_SECRET,
    'planner-key-fixture-1',
    'gw-fixture-99',
    'abcdefghijklmnop',
    API_KEY,
    'hunter22',
    'tok123',
    'eyJhbGciOiJIUzI1NiJ9',
    'hunter2!',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
  ])
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  assert.match(out, /Case \[REDACTED:case-id\] opened/);
  assert.match(out, /\[REDACTED:env:APP_LOGIN\]/);
  assert.match(out, /Bearer \[REDACTED:bearer\]/);
  assert.match(out, /page=2/);
  assert.match(out, /abc stays, \/Users\/somebody stays/);
  // Idempotent: redacting the output again changes nothing.
  assert.equal(redactor.text(out), out);
});

test('deep redaction covers nested values and credential-named keys, and keeps image data URLs', () => {
  const redactor = new Redactor({
    patterns: [{ pattern: 'acme-case-\\d{6}', ignoreCase: true }],
  });
  const value = {
    nested: [{ description: `see ${SUITE_SECRET}` }],
    headers: { authorization: 'anything at all', cookie: 'sid=1' },
    tokens: 12,
    image: 'data:image/png;base64,ACME-CASE-482913',
    when: null,
  };
  const out = redactor.deep(value);
  assert.equal(out.nested[0]!.description, 'see [REDACTED:suite-1]');
  assert.equal(out.headers.authorization, '[REDACTED]');
  assert.equal(out.headers.cookie, '[REDACTED]');
  assert.equal(out.tokens, 12);
  assert.equal(out.image, value.image);
  assert.equal(out.when, null);
  // The input is not modified.
  assert.equal(value.nested[0]!.description, `see ${SUITE_SECRET}`);
});

test('credential environment values are discovered by name, longest first', () => {
  const found = credentialEnvValues(
    {
      A_TOKEN: 'short',
      B_SECRET: 'x'.repeat(12),
      OTHER: 'y'.repeat(20),
      PATH: '/bin:/usr/bin',
    },
    ['OTHER'],
  );
  assert.deepEqual(
    found.map((entry) => entry.name),
    ['OTHER', 'B_SECRET'],
  );
});

test('the evidence policy is strict, rejects unsafe patterns and refuses unsanitizable capture with sensitive content', () => {
  assert.throws(() => evidencePolicySchema.parse({ unknown: true }));
  assert.throws(() =>
    evidencePolicySchema.parse({ redact: [{ pattern: '(' }] }),
  );
  assert.throws(() =>
    evidencePolicySchema.parse({ redact: [{ pattern: 'a*' }] }),
  );
  assert.throws(
    () =>
      evidencePolicySchema.parse({
        redact: [{ pattern: 'x+' }],
        trace: 'local',
      }),
    /cannot be sanitized/,
  );
  assert.throws(() =>
    evidencePolicySchema.parse({
      masks: [{ by: 'testId', value: 'card' }],
      video: 'local',
    }),
  );
  const defaults = evidencePolicySchema.parse({});
  assert.equal(defaults.trace, 'auto');
  assert.equal(defaults.providerScreenshots, true);
  assert.equal(defaults.retentionDays, 30);
  // Masks are web-only.
  assert.throws(
    () =>
      suiteSchema.parse({
        name: 'native',
        platform: 'macos',
        app: { bundleId: 'com.example.app' },
        journeys: [
          {
            id: 'j',
            goal: 'g',
            persona: 'p',
            ready: {
              kind: 'visible',
              target: { by: 'role', role: 'button', name: 'OK' },
            },
            success: [
              {
                kind: 'visible',
                target: { by: 'role', role: 'button', name: 'OK' },
              },
            ],
          },
        ],
        evidence: { masks: [{ by: 'testId', value: 'secret' }] },
      }),
    /cannot be masked/,
  );
});

test('trace and video are disabled and reported when the suite declares sensitive content', () => {
  const status = (
    policy: unknown,
    context: Partial<Parameters<typeof evidenceFormats>[1]> = {},
  ) =>
    Object.fromEntries(
      evidenceFormats(evidencePolicySchema.parse(policy), {
        platform: 'web',
        authenticated: false,
        videoRequested: true,
        ...context,
      }).map((entry) => [entry.format, entry]),
    );
  const open = status({});
  assert.equal(open.trace!.enabled, true);
  assert.equal(open.trace!.protection, 'not_sanitized');
  assert.equal(open.video!.enabled, true);
  const declared = status({ redact: [{ pattern: 'ACME' }] });
  assert.equal(declared.trace!.enabled, false);
  assert.match(declared.trace!.reason, /cannot be sanitized/);
  assert.equal(declared.video!.enabled, false);
  assert.match(declared.video!.reason, /cannot be masked/);
  assert.equal(declared.screenshots!.protection, 'masked');
  assert.equal(declared.provider_screenshots!.enabled, true);
  // A signed-in run's trace holds session cookies.
  assert.equal(status({}, { authenticated: true }).trace!.enabled, false);
  assert.equal(
    status({ trace: 'local' }, { authenticated: true }).trace!.enabled,
    true,
  );
  // Native: no masking, so the provider does not get screenshots of a
  // sensitive suite.
  const native = status(
    { redact: [{ pattern: 'ACME' }] },
    { platform: 'macos' },
  );
  assert.equal(native.provider_screenshots!.enabled, false);
  assert.equal(native.screenshots!.protection, 'not_sanitized');
  assert.equal(
    status({ providerScreenshots: false }).provider_screenshots!.enabled,
    false,
  );
});

test('screenshot masks are applied before capture: masked targets, page text and input values never reach the image', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    const decoder = await browser.newPage();
    // Each secret is drawn in pure red; everything else is dark grey.
    await page.setContent(`<!doctype html><body style="font:32px sans-serif;color:#333;background:#fff">
      <p>Public heading</p>
      <p style="color:#f00">Case ${SUITE_SECRET}</p>
      <div data-testid="card" style="background:#f00;width:200px;height:60px"></div>
      <input style="color:#f00;font-size:32px" value="${ENV_SECRET}">
      <p style="color:#f00">${API_KEY}</p>
    </body>`);
    const plain = await pixelCounts(decoder, await page.screenshot());
    assert.ok(plain.red > 1000, 'the fixture draws its secrets in red');
    const protection = evidenceProtection(
      evidencePolicySchema.parse({
        redact: [{ pattern: 'ACME-CASE-\\d{6}' }],
        redactEnv: ['APP_LOGIN'],
        masks: [{ by: 'testId', value: 'card' }],
      }),
      { APP_LOGIN: ENV_SECRET },
      { platform: 'web', authenticated: false, videoRequested: false },
    );
    const masked = await pixelCounts(
      decoder,
      await protectedScreenshot(page, protection.screenshots),
    );
    assert.equal(masked.red, 0, 'no secret pixel survives in the image');
    assert.ok(masked.mask > 1000, 'the masked areas are filled');
    // The page itself is unchanged after capture.
    assert.equal(await page.getByTestId('card').count(), 1);
    assert.equal(await page.locator('input').inputValue(), ENV_SECRET);
  } finally {
    await browser.close();
  }
});
