import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates, execute, observe } from '../src/browser.js';
import { journeySchema, type Action } from '../src/contracts.js';
import { starterSuite } from '../src/scaffold.js';

// Link patterns of real sites: repeated navigation, card links that share a
// name, image links, <base href>, multi-line link text.
const baseURL = 'https://links.example';
const journey = journeySchema.parse({
  ...starterSuite(baseURL, '/goal').journeys[0]!,
  allowedPaths: ['/', '/pricing', '/docs', '/features', '/fixture'],
});

const nav = '<a href="/pricing">Pricing</a> <a href="/docs">Docs</a>';
const PAGES: Record<string, string> = {
  'header-footer': `<header><nav>${nav}</nav></header><main><h1>Home</h1></main><footer>${nav}</footer>`,
  // Desktop navigation hidden on this viewport, mobile navigation shown.
  responsive: `<nav style="display:none">${nav}</nav><nav style="visibility:hidden;position:absolute">${nav}</nav><main><h1>Home</h1></main><nav>${nav}</nav>`,
  cards:
    '<main><h1>Features</h1><article><h2>Speed</h2><a href="/features/speed">Learn more</a></article><article><h2>Safety</h2><a href="/features/safety">Learn more</a></article></main>',
  image:
    '<header><a href="/"><img alt="Acme home" width="80" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></header><main><h1>Page</h1></main>',
  base: '<head><base href="/docs/"></head><main><h1>Docs index</h1><a href="install">Install guide</a></main>',
  multiline: `<main><h1>Page</h1><a href="/pricing">
      Pricing
      <span>plans</span>
    </a></main>`,
  // Names the page cannot read from text alone: a part hidden by a class
  // and an icon drawn with ::before.
  styled:
    '<style>.hide{display:none}.icon::before{content:"\\2192 "}</style><main><h1>Page</h1><a href="/docs">Docs<span class="hide"> (beta)</span></a> <a href="/pricing"><span class="icon"></span>Plans</a></main>',
};

async function fixture(run: (page: Page, directory: string) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(`${baseURL}/**`, (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({
        contentType: 'text/html',
        body:
          url.pathname === '/fixture'
            ? PAGES[url.searchParams.get('page')!]!
            : `<h1 id="arrived">${url.pathname}</h1>`,
      });
    });
    await run(page, await mkdtemp(join(tmpdir(), 'ui-ux-links-')));
  } finally {
    await browser.close();
  }
}

const links = (actions: Action[]) =>
  actions.flatMap((action) =>
    action.kind === 'link' ? [[action.description, action.href]] : [],
  );

// Opens the offered link with this description and returns where it landed.
async function open(
  page: Page,
  directory: string,
  pageName: string,
  description: string,
): Promise<string> {
  await page.goto(`${baseURL}/fixture?page=${pageName}`);
  const before = await observe(page, 0, join(directory, `${pageName}.png`));
  const action = (await candidates(page, journey, baseURL)).find(
    (candidate) => candidate.description === description,
  );
  assert.ok(action, `${description} is offered on ${pageName}`);
  await execute(page, action, before, journey, baseURL);
  await page.waitForSelector('#arrived');
  return new URL(page.url()).pathname;
}

test('a link repeated in a header and a footer is one action, opened through a visible copy', async () => {
  await fixture(async (page, directory) => {
    for (const pageName of ['header-footer', 'responsive']) {
      await page.goto(`${baseURL}/fixture?page=${pageName}`);
      assert.deepEqual(links(await candidates(page, journey, baseURL)), [
        ['Open Pricing', `${baseURL}/pricing`],
        ['Open Docs', `${baseURL}/docs`],
      ]);
      assert.equal(
        await open(page, directory, pageName, 'Open Docs'),
        '/docs',
        pageName,
      );
    }
  });
});

test('links that share a name but lead to different pages are offered apart, by destination', async () => {
  await fixture(async (page, directory) => {
    await page.goto(`${baseURL}/fixture?page=cards`);
    assert.deepEqual(links(await candidates(page, journey, baseURL)), [
      ['Open Learn more (/features/speed)', `${baseURL}/features/speed`],
      ['Open Learn more (/features/safety)', `${baseURL}/features/safety`],
    ]);
    // The second card's link opens the second card's page.
    assert.equal(
      await open(page, directory, 'cards', 'Open Learn more (/features/safety)'),
      '/features/safety',
    );
  });
});

test('a link is named by its accessible name and resolved against the document base URL', async () => {
  await fixture(async (page, directory) => {
    // An image link is named by the image's alt text.
    assert.equal(await open(page, directory, 'image', 'Open Acme home'), '/');
    // <base href="/docs/">: install resolves to /docs/install, not /install.
    assert.equal(
      await open(page, directory, 'base', 'Open Install guide'),
      '/docs/install',
    );
    // Whitespace in the link text collapses, as in its accessible name.
    assert.equal(
      await open(page, directory, 'multiline', 'Open Pricing plans'),
      '/pricing',
    );
  });
});

test('a link whose name its text does not give is named by the browser', async () => {
  await fixture(async (page, directory) => {
    await page.goto(`${baseURL}/fixture?page=styled`);
    const offered = links(await candidates(page, journey, baseURL));
    // Both are offered, under the names getByRole matches.
    assert.deepEqual(
      offered.map(([, href]) => href),
      [`${baseURL}/docs`, `${baseURL}/pricing`],
    );
    assert.equal(offered[0]![0], 'Open Docs');
    for (const [description, href] of offered)
      assert.equal(
        await open(page, directory, 'styled', description!),
        new URL(href!).pathname,
      );
  });
});
