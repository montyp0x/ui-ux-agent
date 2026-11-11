import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { suiteSchema } from '../src/contracts.js';
import { models } from '../src/models.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { pixelCounts } from './evidence-fixtures.js';

// Planted fixture secrets (none is a real credential). Every one is drawn in
// pure red on the page, so a screenshot that shows any of them has red pixels.
const CASE = 'ACME-CASE-482913';
const TYPED_CASE = 'ACME-CASE-111111';
const ENV_SECRET = 'fixture-env-password-7731';
const PLANNER_KEY = 'planner-key-fixture-1';
const API_KEY = 'sk-fixture0000000000000000abcd';
const URL_TOKEN = 'tok-fixture-55';
const SECRETS = [CASE, TYPED_CASE, ENV_SECRET, PLANNER_KEY, API_KEY, URL_TOKEN];

const RED = 'color:#f00';
const page = (body: string) =>
  `<!doctype html><html lang="en"><title>Evidence fixture</title><body style="font:20px sans-serif;color:#333;background:#fff">${body}</body></html>`;

async function text(request: IncomingMessage): Promise<string> {
  let data = '';
  for await (const chunk of request) data += String(chunk);
  return data;
}

async function fixture() {
  const bodies: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname === '/planner') {
      const body = await text(request);
      bodies.push({ path: url.pathname, body });
      response.setHeader('Content-Type', 'application/json');
      // A provider that echoes secrets back (it never received them; this
      // checks the model-output path into findings, logs and the report).
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  objective: 'Continue to the next page',
                  concerns: [
                    {
                      symptom: `The page shows ${CASE} and ${ENV_SECRET}`,
                      userImpact: `Users see ${API_KEY}`,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === '/selector') {
      const body = await text(request);
      bodies.push({ path: url.pathname, body });
      const criteria = (
        JSON.parse(body) as {
          questions: { action: { criteria: Record<string, string> } };
        }
      ).questions.action.criteria;
      const ids = Object.keys(criteria);
      const choice =
        ids.find((id) => /^(Continue|Type a note)/.test(criteria[id]!)) ??
        ids.find((id) => id !== 'no_match')!;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          answers: {
            action: {
              type: 'choice',
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                ids.map((id) => [id, id === choice ? 1 : 0]),
              ),
            },
          },
        }),
      );
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      // A failing application call whose URL carries a secret.
      response.statusCode = 500;
      response.end(`server error for ${CASE}`);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/next') {
      response.end(
        page(
          `<h1>Done</h1><p style="${RED}">Reference ${CASE}</p><p style="${RED}">${API_KEY}</p>`,
        ),
      );
      return;
    }
    response.end(
      page(`<h1>Evidence fixture</h1>
        <p style="${RED}">Case ${CASE}</p>
        <p style="${RED}">Signed in with ${ENV_SECRET}</p>
        <p style="${RED}">Gateway ${PLANNER_KEY}</p>
        <p style="${RED}">${API_KEY}</p>
        <div data-testid="card" style="background:#f00;width:160px;height:40px"></div>
        <label>Note <input id="note" style="${RED};font-size:20px" value=""></label>
        <a style="${RED}" href="/next?access_token=${URL_TOKEN}&ref=${CASE}">Continue to ${CASE}</a>
        <script>
          console.error('console leak ${CASE} ${ENV_SECRET}');
          setTimeout(() => { throw new Error('page error ${CASE} ${API_KEY}'); }, 0);
          fetch('/api/${CASE}');
          fetch('/api/${CASE}/save', { method: 'POST' }).catch(() => {});
        </script>`),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ready = {
  kind: 'visible',
  target: { by: 'role', role: 'heading', name: 'Evidence fixture' },
};

function suite(baseURL: string) {
  return suiteSchema.parse({
    name: `LOCAL evidence fixture ${CASE}`,
    baseURL,
    viewports: [{ name: 'desktop', width: 1000, height: 800 }],
    evidence: {
      redact: [{ pattern: 'ACME-CASE-\\d{6}', label: 'case-id' }],
      redactEnv: ['APP_LOGIN'],
      masks: [{ by: 'testId', value: 'card' }],
    },
    journeys: [
      {
        id: 'reach',
        goal: `Continue past case ${CASE}`,
        persona: 'A support agent',
        startPath: '/',
        allowedPaths: ['/', '/next'],
        ready,
        success: [
          {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Done' },
          },
        ],
        maxSteps: 4,
        maxDurationMs: 30000,
      },
      {
        // Failure path: types secrets, never reaches its outcome, and the
        // page raises errors, a 500 and a blocked write that carry secrets.
        id: 'stuck',
        goal: 'Write a note',
        persona: 'A support agent',
        startPath: '/',
        allowedPaths: ['/'],
        ready,
        success: [{ kind: 'path', pattern: '^/never$' }],
        interactions: [
          {
            kind: 'fill',
            target: { by: 'label', value: 'Note' },
            description: 'Type a note',
            value: `${ENV_SECRET} ${TYPED_CASE}`,
          },
        ],
        maxSteps: 2,
        maxDurationMs: 30000,
      },
    ],
  });
}

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}

test('planted secrets are absent from every model payload and run artifact, and unsanitizable formats are disabled and reported', async () => {
  const app = await fixture();
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-evidence-')),
    'run',
  );
  const browser = await chromium.launch();
  try {
    const results = await runSuite(
      suite(app.url),
      models({
        plannerURL: `${app.url}/planner`,
        plannerKey: PLANNER_KEY,
        plannerModel: 'fixture-planner',
        selectorURL: `${app.url}/selector`,
        selectorKey: 'selector-fixture-key',
        selectorModel: 'fixture-selector',
      }),
      {
        directory,
        // Requested, but the suite declares sensitive content.
        video: true,
        env: { APP_LOGIN: ENV_SECRET, PLANNER_API_KEY: PLANNER_KEY },
      },
    );
    const [reach, stuck] = results;
    assert.equal(reach!.status, 'passed', reach!.reason);
    assert.equal(stuck!.status, 'failed', stuck!.reason);
    // The failure paths ran: browser errors and the blocked write are findings.
    assert.ok(
      stuck!.findings.some((finding) => finding.category === 'browser-error'),
    );
    assert.ok(
      stuck!.findings.some((finding) => finding.category === 'policy-block'),
    );
    assert.ok(reach!.findings.some((finding) => finding.kind === 'hypothesis'));

    // Outbound payloads: both endpoints were called, and no request body
    // holds a secret. The planner's screenshots are masked.
    const decoder = await browser.newPage();
    assert.ok(app.bodies.some((entry) => entry.path === '/planner'));
    assert.ok(app.bodies.some((entry) => entry.path === '/selector'));
    let images = 0;
    for (const { path, body } of app.bodies) {
      for (const secret of SECRETS)
        assert.ok(!body.includes(secret), `${secret} sent to ${path}`);
      for (const match of body.matchAll(
        /data:image\/png;base64,([A-Za-z0-9+/=]+)/g,
      )) {
        images++;
        const counts = await pixelCounts(
          decoder,
          Buffer.from(match[1]!, 'base64'),
        );
        assert.equal(counts.red, 0, 'a provider screenshot shows a secret');
        assert.ok(counts.mask > 0);
      }
    }
    assert.ok(images > 0, 'the planner received masked screenshots');
    // Redaction keeps the payload usable: the selector still saw the link.
    assert.ok(
      app.bodies.some(
        (entry) =>
          entry.path === '/planner' &&
          entry.body.includes('[REDACTED:case-id]') &&
          entry.body.includes('[REDACTED:url-parameter]'),
      ),
    );

    // Every artifact in the run directory, text and binary alike.
    const written = await files(directory);
    assert.ok(written.some((path) => path.endsWith('events.jsonl')));
    assert.ok(written.some((path) => path.endsWith('report.html')));
    for (const path of written) {
      const raw = await readFile(path);
      for (const secret of SECRETS)
        assert.ok(
          !raw.includes(secret) && !raw.toString('latin1').includes(secret),
          `${secret} found in ${path}`,
        );
      assert.ok(
        !['.zip', '.webm'].includes(extname(path)),
        `unsanitizable ${path} was written`,
      );
      if (extname(path) === '.png') {
        const counts = await pixelCounts(decoder, raw);
        assert.equal(counts.red, 0, `${path} shows a secret`);
      }
    }

    // Run evidence stays private to the user.
    assert.equal((await stat(directory)).mode & 0o077, 0);

    // Disabled formats are reported in the result, the events and the report.
    for (const result of parseResults(
      await readFile(join(directory, 'results.json'), 'utf8'),
    )) {
      assert.equal(result.trace, null);
      assert.equal(result.video, null);
      const formats = Object.fromEntries(
        result.evidence.formats.map((entry) => [entry.format, entry]),
      );
      assert.equal(formats.trace!.enabled, false);
      assert.match(formats.trace!.reason, /cannot be sanitized/);
      assert.equal(formats.video!.enabled, false);
      assert.match(formats.video!.reason, /cannot be masked/);
      assert.equal(formats.screenshots!.protection, 'masked');
      assert.deepEqual(result.evidence.redactedEnv.sort(), [
        'APP_LOGIN',
        'PLANNER_API_KEY',
      ]);
    }
    const report = await readFile(join(directory, 'report.html'), 'utf8');
    assert.match(report, /2 format\(s\) disabled \(trace, video\)/);
    assert.match(report, /No trace captured/);
    assert.match(report, /not a guarantee for arbitrary unknown sensitive/);
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.match(events, /"event":"evidence_policy"/);
    // The secrets did reach every path, and were replaced there.
    for (const event of ['console_error', 'policy_block', 'observation'])
      assert.match(events, new RegExp(`"event":"${event}"`));
    for (const token of [
      '[REDACTED:case-id]',
      '[REDACTED:env:APP_LOGIN]',
      '[REDACTED:env:PLANNER_API_KEY]',
      '[REDACTED:api-key]',
      '[REDACTED:url-parameter]',
    ])
      assert.ok(events.includes(token), `${token} not in events`);
  } finally {
    await browser.close();
    await app.close();
  }
});

test('an existing run directory is never reused or overwritten', async () => {
  const app = await fixture();
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-evidence-')),
    'run',
  );
  const decide = {
    async plan() {
      return { objective: 'Continue', concerns: [] };
    },
    async choose() {
      return {
        type: 'choice' as const,
        choice: 'no_match',
        confidence: 1,
        probabilities: { no_match: 1 },
      };
    },
  };
  try {
    const parsed = suite(app.url);
    const only = { ...parsed, journeys: [parsed.journeys[0]!] };
    await assert.rejects(
      runSuite(only, decide, { directory: tmpdir() }),
      /EEXIST/,
    );
    const manifest = join(directory, 'run.json');
    await runSuite(only, decide, { directory, env: {} }).catch(() => []);
    const before = await readFile(manifest, 'utf8');
    await assert.rejects(
      runSuite(only, decide, { directory, env: {} }),
      /EEXIST/,
    );
    assert.equal(await readFile(manifest, 'utf8'), before);
    assert.equal(JSON.parse(before).uploaded, false);
  } finally {
    await app.close();
  }
});
