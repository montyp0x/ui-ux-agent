import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates, execute, observe } from '../src/browser.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://fixture.example';
const journey = starterSuite(baseURL, '/destination').journeys[0]!;
const nestedPage = `<style>body{margin:0}main{height:844px;overflow:auto;overscroll-behavior:contain}section{height:300px;overflow:auto;overscroll-behavior:contain}</style>
<main aria-label="Main page"><a href="/destination">Recent session</a><div style="height:980px">Summary cards</div><section aria-label="Activity feed"><div style="height:900px">Feed entries</div></section><footer style="height:100px">End of page</footer></main>`;

async function fixture(run: (page: Page, directory: string) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.route(`${baseURL}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: nestedPage }),
    );
    await page.goto(baseURL);
    await page.locator('main').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await run(page, await mkdtemp(join(tmpdir(), 'ui-ux-scroll-regions-')));
  } finally {
    await browser.close();
  }
}

test('escape a nested feed, return to main-page navigation and reach the session', async () => {
  await fixture(async (page, directory) => {
    // At the old fixed wheel point the feed is already at its top, with scroll
    // chaining disabled. Wheeling up here cannot return to page navigation.
    const initialMain = await page
      .locator('main')
      .evaluate((element) => element.scrollTop);
    await page.mouse.move(195, 844 * 0.7);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator('main').evaluate((element) => element.scrollTop),
      initialMain,
    );
    const before = await observe(page, 0, join(directory, 'feed.png'));
    let offered = await candidates(page, journey, baseURL);
    assert.ok(
      offered.some(
        (action) => action.kind === 'scroll' && action.direction === 'up',
      ),
      'An outer upward action must be reachable while the fixed point is trapped',
    );
    const feedDown = offered.find(
      (action) =>
        action.kind === 'scroll' &&
        action.direction === 'down' &&
        action.description.includes('Activity feed'),
    );
    assert.ok(feedDown, 'The feed must have its own scroll action');
    await execute(page, feedDown, before, journey, baseURL);
    await page.waitForTimeout(100);
    const feedPosition = await page
      .locator('section')
      .evaluate((element) => element.scrollTop);
    assert.ok(feedPosition > 0);
    assert.equal(
      await page.locator('main').evaluate((element) => element.scrollTop),
      initialMain,
    );

    const inFeed = await observe(page, 1, join(directory, 'in-feed.png'));
    offered = await candidates(page, journey, baseURL);
    const mainUp = offered.find(
      (action) =>
        action.kind === 'scroll' &&
        action.direction === 'up' &&
        action.description.includes('Main page'),
    );
    assert.ok(
      mainUp,
      'Main-page upward scroll must remain available beside the feed',
    );
    await execute(page, mainUp, inFeed, journey, baseURL);
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator('section').evaluate((element) => element.scrollTop),
      feedPosition,
    );
    assert.equal(
      await page.locator('main').evaluate((element) => element.scrollTop),
      0,
    );

    const atTop = await observe(page, 2, join(directory, 'navigation.png'));
    offered = await candidates(page, journey, baseURL);
    const session = offered.find(
      (action) =>
        action.kind === 'link' && action.description.includes('Recent session'),
    );
    assert.ok(session);
    await execute(page, session, atTop, journey, baseURL);
    assert.equal(new URL(page.url()).pathname, '/destination');
  });
});

test('a replacement or a new scroll recipient cannot inherit a selected region action', async () => {
  for (const mutation of ['replacement', 'overlay', 'hidden']) {
    await fixture(async (page, directory) => {
      const before = await observe(page, 0, join(directory, 'before.png'));
      const action = (await candidates(page, journey, baseURL)).find(
        (action) =>
          action.kind === 'scroll' &&
          action.direction === 'up' &&
          action.description.includes('Main page'),
      );
      assert.ok(action);
      const position = await page
        .locator('main')
        .evaluate((element) => element.scrollTop);
      if (mutation === 'replacement') {
        await page.locator('main').evaluate((element) => {
          const replacement = element.cloneNode(true) as HTMLElement;
          const top = element.scrollTop;
          element.replaceWith(replacement);
          replacement.scrollTop = top;
        });
      } else if (mutation === 'hidden') {
        await page.locator('main').evaluate((element) => {
          (element as HTMLElement).style.opacity = '0';
        });
      } else {
        await page.evaluate(() => {
          const overlay = document.createElement('aside');
          overlay.style.cssText =
            'position:fixed;inset:0;overflow:auto;background:white';
          overlay.innerHTML =
            '<div style="height:3000px">Another scrolling task</div>';
          document.body.append(overlay);
          overlay.scrollTop = 600;
        });
      }
      await assert.rejects(
        execute(page, action, before, journey, baseURL),
        /Stale observation: scroll container or position/,
      );
      assert.equal(
        await page.locator('main').evaluate((element) => element.scrollTop),
        position,
      );
    });
  }
});

test('modal scroll discovery excludes the background main page and feed', async () => {
  await fixture(async (page, directory) => {
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Confirmation');
      dialog.style.cssText = 'height:200px;overflow:auto';
      dialog.innerHTML = '<div style="height:1000px">Long confirmation</div>';
      document.body.append(dialog);
      dialog.showModal();
    });
    const state = await observe(page, 0, join(directory, 'modal.png'));
    assert.ok(
      state.visibleViewport.scrollRegions.some(
        (region) => region.label === 'Confirmation',
      ),
    );
    const scrolls = (await candidates(page, journey, baseURL)).filter(
      (action) => action.kind === 'scroll',
    );
    assert.ok(scrolls.length > 0);
    assert.ok(
      scrolls.every((action) => action.description.includes('Confirmation')),
    );
  });
});

test('a panel opened by pointer movement is checked before the wheel is dispatched', async () => {
  await fixture(async (page, directory) => {
    const before = await observe(page, 0, join(directory, 'before-hover.png'));
    const action = (await candidates(page, journey, baseURL)).find(
      (action) =>
        action.kind === 'scroll' &&
        action.direction === 'up' &&
        action.description.includes('Main page'),
    );
    assert.ok(action);
    const position = await page
      .locator('main')
      .evaluate((element) => element.scrollTop);
    await page.locator('main').evaluate((element) => {
      element.addEventListener(
        'mousemove',
        () => {
          const overlay = document.createElement('aside');
          overlay.style.cssText =
            'position:fixed;inset:0;overflow:auto;background:white';
          overlay.innerHTML = '<div style="height:3000px">Hover panel</div>';
          document.body.append(overlay);
          overlay.scrollTop = 600;
        },
        { once: true },
      );
    });
    await assert.rejects(
      execute(page, action, before, journey, baseURL),
      /Stale observation: scroll container or position/,
    );
    assert.equal(
      await page.locator('main').evaluate((element) => element.scrollTop),
      position,
    );
    assert.equal(
      await page.locator('aside').evaluate((element) => element.scrollTop),
      600,
    );
  });
});

test('scrolling an open shadow-root panel records progress and exposes its link', async () => {
  await fixture(async (page, directory) => {
    await page.setContent('<div id="host"></div>');
    await page.locator('#host').evaluate((element) => {
      element.attachShadow({ mode: 'open' }).innerHTML =
        '<section aria-label="Shadow feed" style="height:300px;overflow:auto;overscroll-behavior:contain"><div style="height:600px">More entries</div><a href="/destination">Recent session</a></section>';
    });
    const before = await observe(page, 0, join(directory, 'shadow-before.png'));
    const action = (await candidates(page, journey, baseURL)).find(
      (action) =>
        action.kind === 'scroll' &&
        action.direction === 'down' &&
        action.description.includes('Shadow feed'),
    );
    assert.ok(action);
    await execute(page, action, before, journey, baseURL);
    const after = await observe(page, 1, join(directory, 'shadow-after.png'));
    assert.notDeepEqual(after.scroll, before.scroll);
    assert.notEqual(after.fingerprint, before.fingerprint);
    const link = (await candidates(page, journey, baseURL)).find(
      (action) => action.kind === 'link',
    );
    assert.ok(link);
    await execute(page, link, after, journey, baseURL);
    assert.equal(new URL(page.url()).pathname, '/destination');
  });
});
