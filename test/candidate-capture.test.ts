import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates, execute, observe } from '../src/browser.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://fixture.example';
const journey = {
  ...starterSuite(baseURL, '/destination').journeys[0]!,
  allowedPaths: ['/destination', '/teams', '/usage'],
};
const links =
  '<a id="home" href="/destination">Home</a><a id="teams" href="/teams">Teams</a><a id="usage" href="/usage">Usage</a>';

type Logged = { event: string; data: Record<string, unknown> };

async function fixture(
  setup: string,
  run: (page: Page, directory: string, logged: Logged[]) => Promise<void>,
) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.route('https://fixture.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<h1>Fixture</h1>${links}<script>${setup}</script>`,
      }),
    );
    await page.goto(baseURL);
    // The production default; a capture that waits it out is the reported failure.
    page.setDefaultTimeout(5000);
    await run(page, await mkdtemp(join(tmpdir(), 'ui-ux-capture-')), []);
  } finally {
    await browser.close();
  }
}

function offerWith(page: Page, logged: Logged[]) {
  return candidates(page, journey, baseURL, [], async (event, data) => {
    logged.push({ event, data: data as Record<string, unknown> });
  });
}

// controlState reads formAction on every offered control, so a getter on an
// earlier link runs while later candidates are still waiting to be bound.
const removeTeamsWhileBindingHome = `
  Object.defineProperty(document.getElementById('home'), 'formAction', {
    get() { document.getElementById('teams')?.remove(); return undefined; },
  });
`;

test('an unused candidate that disappears during binding is skipped with evidence', async () => {
  await fixture(
    removeTeamsWhileBindingHome,
    async (page, directory, logged) => {
      const before = await observe(page, 0, join(directory, 'before.png'));
      const started = Date.now();
      const offered = await offerWith(page, logged);
      assert.ok(
        Date.now() - started < 2500,
        'a vanished candidate must not wait out the default timeout',
      );
      assert.deepEqual(
        offered.map((action) => action.description),
        ['Open Home', 'Open Usage', 'Wait briefly for loading to finish'],
      );
      assert.deepEqual(
        offered.map((action) => action.id),
        ['a0', 'a1', 'a2'],
      );
      const skipped = logged.filter(
        (entry) => entry.event === 'candidate_skipped',
      );
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0]!.data.action, 'Open Teams');
      assert.equal(skipped[0]!.data.reason, 'detached');
      assert.equal(skipped[0]!.data.matches, 0);
      assert.equal(skipped[0]!.data.journey, journey.id);
      // Remaining actions keep their full guards and still execute.
      await execute(page, offered[1]!, before, journey, baseURL);
      assert.equal(new URL(page.url()).pathname, '/usage');
    },
  );
});

test('a candidate that vanishes after its handle is taken is skipped promptly', async () => {
  await fixture(
    `
    Object.defineProperty(document.getElementById('teams'), 'formAction', {
      get() { this.remove(); return undefined; },
    });
    `,
    async (page, _directory, logged) => {
      const started = Date.now();
      const offered = await offerWith(page, logged);
      assert.ok(Date.now() - started < 2500);
      assert.ok(!offered.some((action) => action.description === 'Open Teams'));
      const skipped = logged.filter(
        (entry) => entry.event === 'candidate_skipped',
      );
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0]!.data.reason, 'detached');
      assert.equal(skipped[0]!.data.matches, 0);
      assert.match(String(skipped[0]!.data.detail), /Timeout 1000ms/);
    },
  );
});

test('a candidate replaced while its state is captured is skipped, not bound to the replacement', async () => {
  await fixture(
    `
    Object.defineProperty(document.getElementById('teams'), 'formAction', {
      get() {
        if (this.isConnected) this.replaceWith(this.cloneNode(true));
        return undefined;
      },
    });
    `,
    async (page, _directory, logged) => {
      const offered = await offerWith(page, logged);
      assert.ok(!offered.some((action) => action.description === 'Open Teams'));
      const skipped = logged.filter(
        (entry) => entry.event === 'candidate_skipped',
      );
      assert.deepEqual(
        skipped.map((entry) => [entry.data.action, entry.data.reason]),
        [['Open Teams', 'replaced']],
      );
    },
  );
});

test('a capture failure on a candidate that is still present is not hidden', async () => {
  await fixture(
    `
    Object.defineProperty(document.getElementById('teams'), 'formAction', {
      get() { throw new Error('capture boom'); },
    });
    `,
    async (page, _directory, logged) => {
      await assert.rejects(offerWith(page, logged), /capture boom/);
      assert.equal(
        logged.filter((entry) => entry.event === 'candidate_skipped').length,
        0,
      );
    },
  );
});

test('a candidate that disappears after offering still cannot execute', async () => {
  await fixture('', async (page, directory, logged) => {
    const before = await observe(page, 0, join(directory, 'before.png'));
    const offered = await offerWith(page, logged);
    const teams = offered.find((action) => action.description === 'Open Teams');
    assert.ok(teams);
    await page.locator('#teams').evaluate((element) => element.remove());
    page.setDefaultTimeout(500);
    await assert.rejects(
      execute(page, teams, before, journey, baseURL),
      /Stale observation: selected target is unavailable/,
    );
    assert.equal(
      logged.filter((entry) => entry.event === 'candidate_skipped').length,
      0,
    );
  });
});
