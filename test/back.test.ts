import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates, execute, observe } from '../src/browser.js';
import type { Action } from '../src/contracts.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://fixture.example';
const journey = {
  ...starterSuite(baseURL, '/b').journeys[0]!,
  allowedPaths: ['/', '/b', '/spa'],
};

async function fixture(run: (page: Page, directory: string) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://fixture.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<h1>${new URL(route.request().url()).pathname}</h1><a href="/b">B</a>`,
      }),
    );
    await run(page, await mkdtemp(join(tmpdir(), 'ui-ux-back-')));
  } finally {
    await browser.close();
  }
}

const back = (actions: Action[]) =>
  actions.find((action) => action.kind === 'back');

test('back is offered only with an in-scope previous entry, and returns to it', async () => {
  await fixture(async (page, directory) => {
    await page.goto(`${baseURL}/`);
    assert.equal(back(await candidates(page, journey, baseURL)), undefined);
    await page.goto(`${baseURL}/b`);
    const before = await observe(page, 0, join(directory, 'b.png'));
    const action = back(await candidates(page, journey, baseURL));
    assert.ok(action && action.kind === 'back');
    assert.equal(action.description, 'Go back to the previous page (/)');
    await execute(page, action, before, journey, baseURL);
    assert.equal(new URL(page.url()).pathname, '/');
  });
});

test('back is not offered when the previous entry is outside the journey scope', async () => {
  await fixture(async (page) => {
    await page.goto(`${baseURL}/outside`);
    await page.goto(`${baseURL}/b`);
    assert.equal(back(await candidates(page, journey, baseURL)), undefined);
  });
});

test('back follows client-side history entries', async () => {
  await fixture(async (page, directory) => {
    await page.goto(`${baseURL}/`);
    await page.evaluate(() => history.pushState({}, '', '/spa?tab=2'));
    const before = await observe(page, 0, join(directory, 'spa.png'));
    const action = back(await candidates(page, journey, baseURL));
    assert.ok(action);
    await execute(page, action, before, journey, baseURL);
    assert.equal(new URL(page.url()).pathname, '/');
  });
});

test('back is stale when the history moved after it was offered, even at the same URL', async () => {
  await fixture(async (page, directory) => {
    await page.goto(`${baseURL}/`);
    await page.goto(`${baseURL}/b`);
    const before = await observe(page, 0, join(directory, 'b.png'));
    const action = back(await candidates(page, journey, baseURL));
    assert.ok(action);
    await page.evaluate(() => history.pushState({}, '', location.href));
    await assert.rejects(
      execute(page, action, before, journey, baseURL),
      /Stale observation: browser history changed/,
    );
    assert.equal(new URL(page.url()).pathname, '/b');
  });
});
