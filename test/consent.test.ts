import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  suiteSchema,
  type Action,
  type Choice,
} from '../src/contracts.js';
import type { Models } from '../src/models.js';
import type { Finding } from '../src/results.js';
import { runSuite } from '../src/runner.js';

// A site whose modal cookie banner covers the page until it is dismissed.
async function site() {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      request.url === '/pricing'
        ? '<h1>Pricing</h1>'
        : `<nav><a href="/pricing">Pricing</a></nav><main><h1>Home</h1></main>
<div role="dialog" aria-modal="true" aria-labelledby="consent-title" id="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
  <div style="background:#fff;margin:20vh auto;width:320px;padding:20px">
    <h2 id="consent-title">Your privacy choices</h2><p>We use cookies.</p>
    <button onclick="document.getElementById('consent').remove()">Reject all</button>
    <button onclick="document.getElementById('consent').remove()">Accept all</button>
  </div>
</div>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

const selected = (choice: string, actions: Action[]): Choice => ({
  type: 'choice',
  choice,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
    ['no_match', choice === 'no_match' ? 1 : 0],
  ]),
});
// Opens the pricing link when it is offered.
const models: Models = {
  async plan() {
    return { objective: 'Open pricing', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return selected(
      actions.find((action) => action.kind === 'link')?.id ?? 'no_match',
      actions,
    );
  },
};

const reject = {
  kind: 'click',
  target: { by: 'role', role: 'button', name: 'Reject all' },
  description: 'Reject optional cookies',
};
const suite = (url: string, journey: Record<string, unknown> = {}) =>
  suiteSchema.parse({
    name: 'consent',
    baseURL: url,
    requiresAuth: false,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [
      {
        id: 'pricing',
        goal: 'Find the pricing',
        persona: 'A visitor',
        startPath: '/',
        allowedPaths: ['/', '/pricing'],
        ready: { kind: 'visible', target: { by: 'role', role: 'heading', name: 'Home' } },
        success: [{ kind: 'path', pattern: '^/pricing$' }],
        maxSteps: 3,
        maxDurationMs: 15000,
        ...journey,
      },
    ],
  });

// Rendered behind the banner: anyRendered does not need it to be in view.
const behindBanner = {
  ready: {
    kind: 'anyRendered',
    target: { by: 'role', role: 'heading', name: 'Home' },
  },
};
const blockingDialogs = (findings: Finding[]) =>
  findings.filter((finding) => finding.category === 'blocking-dialog');

test('a ready check the banner hides names the banner instead of blaming authentication', async () => {
  const app = await site();
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-consent-')), 'run');
    const [result] = await runSuite(suite(app.url), models, { directory });
    assert.equal(result!.outcome.code, 'ready_not_reached');
    assert.match(result!.reason, /modal dialog "Your privacy choices"/);
    assert.match(result!.reason, /anyRendered or a path/);
    assert.doesNotMatch(result!.reason, /authentication/);
    assert.equal(blockingDialogs(result!.findings).length, 1);
    assert.match(result!.outcome.evidence.screenshot ?? '', /ready\.png$/);
  } finally {
    app.close();
  }
});

test('a banner that leaves no page action is reported once as a blocking dialog, by name', async () => {
  const app = await site();
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-consent-')), 'run');
    const [result] = await runSuite(suite(app.url, behindBanner), models, {
      directory,
    });
    assert.notEqual(result!.status, 'passed');
    // Once, however many steps it stayed.
    const blocking = blockingDialogs(result!.findings);
    assert.equal(blocking.length, 1, JSON.stringify(result!.findings));
    assert.equal(blocking[0]!.kind, 'observed');
    assert.match(blocking[0]!.description, /"Your privacy choices"/);
    assert.match(blocking[0]!.description, /setup/);
  } finally {
    app.close();
  }
});

test('dismissing the banner in setup opens the page to the journey', async () => {
  const app = await site();
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-consent-')), 'run');
    const [result] = await runSuite(
      suite(app.url, { ...behindBanner, interactions: [reject], setup: [reject] }),
      models,
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    assert.ok(
      !result!.findings.some((finding) => finding.category === 'blocking-dialog'),
    );
  } finally {
    app.close();
  }
});
