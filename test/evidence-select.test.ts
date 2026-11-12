// A select option whose value is a secret (a dataLifecycle setup value) names
// the secret choice by its label as well: the label and text are redacted as
// text wherever the value is (observation snapshots, model payloads,
// events.jsonl, results, the report), not only masked in screenshots. Local
// fixture service, scripted decisions, no model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  suiteEvidencePolicy,
  suiteSchema,
  type Suite,
} from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { evidenceProtection } from '../src/evidence/protection.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { scriptedDecisions } from '../examples/state-fixture.js';

// Planted fixture values (not real data). The account id is the secret setup
// value; the label the select shows for it is different text.
const ACCOUNT = 'acct-fixture-90417';
const LABEL = 'Northwind Ops Desk';

async function accountFixture() {
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname.startsWith('/__fixture/')) {
      response.setHeader('content-type', 'application/json');
      response.end(
        url.pathname === '/__fixture/setup'
          ? JSON.stringify({ values: { account: ACCOUNT } })
          : '{}',
      );
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html lang="en"><title>Accounts</title>
      <body style="font:20px sans-serif"><h1>Accounts</h1>
      <label for="account">Account</label> <select id="account">
        <option value="">Choose…</option>
        <option value="other-account">Other account</option>
        <option value="${ACCOUNT}">${LABEL}</option>
      </select>
      <p data-testid="chosen"></p><p data-testid="status"></p>
      <script>
        const select = document.querySelector('#account');
        select.addEventListener('change', () => {
          document.querySelector('[data-testid=chosen]').textContent =
            'Chosen: ' + select.selectedOptions[0].text;
          document.querySelector('[data-testid=status]').textContent = 'Saved';
        });
      </script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function accountSuite(
  url: string,
  extra: Record<string, unknown> = {},
  journey: Record<string, unknown> = {},
): Suite {
  return suiteSchema.parse({
    name: 'Secret select fixture',
    baseURL: url,
    requiresAuth: false,
    viewports: [{ name: 'desktop', width: 1000, height: 700 }],
    dataLifecycle: {
      service: url,
      reset: { method: 'POST', path: '/__fixture/reset' },
      setup: { method: 'POST', path: '/__fixture/setup' },
      cleanup: { method: 'POST', path: '/__fixture/cleanup' },
      timeoutMs: 5000,
    },
    journeys: [
      {
        id: 'pick-account',
        goal: 'Pick the test account',
        persona: 'An operator with a disposable test account',
        startPath: '/',
        allowedPaths: ['/'],
        ready: { kind: 'visible', target: { by: 'label', value: 'Account' } },
        interactions: [
          {
            kind: 'select',
            target: { by: 'label', value: 'Account' },
            value: '{{data.account}}',
            description: 'Pick the account',
          },
        ],
        success: [
          {
            kind: 'text',
            target: { by: 'testId', value: 'status' },
            pattern: '^Saved$',
          },
        ],
        maxSteps: 6,
        maxDurationMs: 30000,
        ...journey,
      },
    ],
    ...extra,
  }) as Suite;
}

// The scripted decisions, recording everything the adapters receive (the
// provider-visible view: runSuite redacts it before calling them).
function recording(): { models: Models; payloads: string[] } {
  const scripted = scriptedDecisions({ 'pick-account': ['Pick the account'] });
  const payloads: string[] = [];
  return {
    payloads,
    models: {
      plan(...args) {
        payloads.push(JSON.stringify(args));
        return scripted.plan(...args);
      },
      choose(...args) {
        payloads.push(JSON.stringify(args));
        return scripted.choose(...args);
      },
    },
  };
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

test('the label of a select option whose value is a secret setup value is redacted as text wherever the value is', async () => {
  const app = await accountFixture();
  try {
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-secret-select-')),
      'run',
    );
    const { models, payloads } = recording();
    const [result] = await runSuite(accountSuite(app.url), models, {
      directory,
    });
    assert.equal(result!.status, 'passed', result!.reason);
    // The page showed the label: in the snapshot and viewport text the
    // adapters received, it is redacted with the secret's own label.
    assert.ok(payloads.length > 0);
    for (const payload of payloads) {
      assert.ok(!payload.includes(ACCOUNT), 'the value reached a model');
      assert.ok(!payload.includes(LABEL), 'the option label reached a model');
    }
    assert.ok(
      payloads.some((payload) =>
        payload.includes('[REDACTED:data:account:option]'),
      ),
    );
    const written = await files(directory);
    for (const name of ['events.jsonl', 'results.json', 'report.html'])
      assert.ok(
        written.some((path) => path.endsWith(name)),
        `${name} was written`,
      );
    for (const path of written) {
      const content = (await readFile(path)).toString('latin1');
      assert.ok(!content.includes(ACCOUNT), `the value is in ${path}`);
      assert.ok(!content.includes(LABEL), `the option label is in ${path}`);
    }
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.ok(events.includes('[REDACTED:data:account:option]'));
    const [recorded] = parseResults(
      await readFile(join(directory, 'results.json'), 'utf8'),
    );
    assert.deepEqual(recorded!.evidence.redactedData, ['account']);
  } finally {
    await app.close();
  }
});

test('option labels of secret values are learned once, and a label too short to redact is listed as a limitation', async () => {
  const protection = evidenceProtection(
    suiteEvidencePolicy(accountSuite('http://127.0.0.1:4175')),
    {},
    { platform: 'web', authenticated: false, videoRequested: false },
  );
  // Before the run learns the value, nothing is a secret option.
  protection.learnOptionLabels([{ value: ACCOUNT, texts: [LABEL] }]);
  assert.equal(protection.redactor.text(LABEL), LABEL);
  protection.beginRun({ account: ACCOUNT }, []);
  protection.learnOptionLabels([
    { value: ACCOUNT, texts: [LABEL, ` ${LABEL} `, ACCOUNT] },
    { value: 'other-account', texts: ['Other account'] },
    { value: '', texts: ['Choose…'] },
  ]);
  assert.equal(
    protection.redactor.text(`Chosen: ${LABEL}`),
    'Chosen: [REDACTED:data:account:option]',
  );
  assert.equal(protection.redactor.text(ACCOUNT), '[REDACTED:data:account]');
  assert.equal(protection.redactor.text('Other account'), 'Other account');
  assert.deepEqual(protection.report(0).limitations, []);
  // A label shorter than 4 characters cannot be redacted as text; the gap is
  // named (never the label or its length), once.
  protection.learnOptionLabels([{ value: ACCOUNT, texts: ['Ops'] }]);
  protection.learnOptionLabels([{ value: ACCOUNT, texts: ['Ops'] }]);
  const limitations = protection.report(0).limitations;
  assert.equal(limitations.length, 1);
  assert.match(
    limitations[0]!,
    /option label of a select whose value is data:account/,
  );
  assert.ok(!limitations[0]!.includes('Ops'));
});

test('trace: local with a setup value no journey uses loads, and the run turns the trace off with the reason', async () => {
  const app = await accountFixture();
  try {
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-secret-select-')),
      'run',
    );
    // The journey reads no {{data.*}} value: not refused at load.
    const suite = accountSuite(
      app.url,
      { evidence: { trace: 'local' } },
      {
        interactions: [],
        success: [
          { kind: 'visible', target: { by: 'label', value: 'Account' } },
        ],
      },
    );
    const [result] = await runSuite(
      suite,
      scriptedDecisions({ 'pick-account': [] }),
      { directory },
    );
    assert.equal(result!.trace, null);
    const trace = result!.evidence.formats.find(
      (entry) => entry.format === 'trace',
    )!;
    assert.equal(trace.enabled, false);
    assert.match(
      trace.reason,
      /dataLifecycle setup returned secret values \(account\) that trace: 'local' cannot sanitize/,
    );
    assert.ok(!(await files(directory)).some((path) => path.endsWith('.zip')));
  } finally {
    await app.close();
  }
});

test('a run is sensitive for the rest of the suite once setup returned a secret', () => {
  const protection = evidenceProtection(
    suiteEvidencePolicy(accountSuite('http://127.0.0.1:4175')),
    {},
    { platform: 'web', authenticated: false, videoRequested: true },
  );
  const trace = () =>
    protection.formats.find((entry) => entry.format === 'trace')!.enabled;
  const video = () =>
    protection.formats.find((entry) => entry.format === 'video')!.enabled;
  // The suite's journeys use {{data.account}}: sensitive from load.
  assert.equal(trace(), false);

  const unreferenced = accountSuite(
    'http://127.0.0.1:4175',
    {},
    { interactions: [] },
  );
  const later = evidenceProtection(
    suiteEvidencePolicy(unreferenced),
    {},
    { platform: 'web', authenticated: false, videoRequested: true },
  );
  assert.equal(later.sensitive, false);
  assert.equal(later.formats.find((e) => e.format === 'trace')!.enabled, true);
  later.beginRun({ account: ACCOUNT }, []);
  // A later run whose setup returns nothing still shows no trace or video:
  // the earlier secret stays a secret, and its page may still show it.
  later.beginRun({}, []);
  assert.equal(later.sensitive, true);
  assert.equal(later.formats.find((e) => e.format === 'trace')!.enabled, false);
  assert.equal(later.formats.find((e) => e.format === 'video')!.enabled, false);
  assert.equal(video(), false);
});
