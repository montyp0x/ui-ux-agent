import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates, check, observe } from '../src/browser.js';
import { models } from '../src/models.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://fixture.example';
const journey = starterSuite(baseURL, '/destination').journeys[0]!;

async function fixture(
  html: string,
  run: (page: Page, directory: string) => Promise<void>,
) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.route(`${baseURL}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto(baseURL);
    await run(page, await mkdtemp(join(tmpdir(), 'ui-ux-viewport-')));
  } finally {
    await browser.close();
  }
}

test('below-fold content reaches both model adapters only after scrolling into view', async () => {
  await fixture(
    '<h1>Visible heading</h1><div style="height:1000px"></div><a href="/destination">Buried sentinel</a>',
    async (page, directory) => {
      const requests: string[] = [];
      const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += String(chunk);
        requests.push(raw);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify(
            request.url === '/planner'
              ? {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          objective: 'Explore the page',
                          concerns: [],
                        }),
                      },
                    },
                  ],
                }
              : {
                  answers: {
                    action: {
                      type: 'choice',
                      choice: 'no_match',
                      confidence: 1,
                      probabilities: { no_match: 1 },
                    },
                  },
                },
          ),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}`;
        const agent = models({
          plannerURL: `${url}/planner`,
          plannerKey: 'fixture',
          plannerModel: 'fixture',
          selectorURL: `${url}/selector`,
          selectorKey: 'fixture',
          selectorModel: 'fixture',
        });
        const before = await observe(page, 0, join(directory, 'before.png'));
        assert.match(before.snapshot, /Buried sentinel/);
        assert.doesNotMatch(before.visibleViewport.text, /Buried sentinel/);
        assert.equal(before.visibleViewport.canScrollDown, true);
        assert.equal(before.visibleViewport.canScrollUp, false);
        assert.deepEqual(
          (await candidates(page, journey, baseURL))
            .filter((action) => action.kind === 'scroll')
            .map((action) => action.direction),
          ['down'],
        );
        const plan = await agent.plan(journey, before, [], 5000);
        await agent.choose(journey, before, plan, [], [], 5000);
        for (const raw of requests) {
          assert.match(raw, /Visible heading/);
          assert.doesNotMatch(
            raw,
            /Buried sentinel|"snapshot"|"fingerprint"|before\.png/,
          );
        }
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        const after = await observe(page, 1, join(directory, 'after.png'));
        assert.match(after.visibleViewport.text, /Buried sentinel/);
        assert.equal(after.visibleViewport.canScrollDown, false);
        assert.equal(after.visibleViewport.canScrollUp, true);
        assert.deepEqual(
          (await candidates(page, journey, baseURL))
            .filter((action) => action.kind === 'scroll')
            .map((action) => action.direction),
          ['up'],
        );
        await agent.plan(journey, after, [], 5000);
        await agent.choose(journey, after, plan, [], [], 5000);
        for (const raw of requests.slice(2))
          assert.match(raw, /Buried sentinel/);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

test('a nested clipped link is neither visible nor offered until its container scrolls', async () => {
  await fixture(
    '<main style="height:300px;overflow:auto"><p>Visible item</p><div style="height:400px"></div><a href="/destination">Clipped destination</a></main>',
    async (page, directory) => {
      const condition = {
        kind: 'visible' as const,
        target: {
          by: 'role' as const,
          role: 'link' as const,
          name: 'Clipped destination',
        },
      };
      assert.equal(await page.getByRole('link').isVisible(), true); // Playwright alone ignores clipping.
      assert.equal(await check(page, condition), false);
      assert.equal(
        await check(page, { ...condition, kind: 'anyVisible' }),
        false,
      );
      assert.equal(
        (await candidates(page, journey, baseURL)).some(
          (action) => action.kind === 'link',
        ),
        false,
      );
      assert.doesNotMatch(
        (await observe(page, 0, join(directory, 'before.png'))).visibleViewport
          .text,
        /Clipped destination/,
      );
      await page.locator('main').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      assert.equal(await check(page, condition), true);
      assert.equal(
        (await candidates(page, journey, baseURL)).some(
          (action) => action.kind === 'link',
        ),
        true,
      );
      assert.match(
        (await observe(page, 1, join(directory, 'after.png'))).visibleViewport
          .text,
        /Clipped destination/,
      );
    },
  );
});

test('partially clipped paragraphs do not disclose words outside the visible line', async () => {
  await fixture(
    '<div style="height:20px;overflow:hidden"><p style="margin:0;line-height:20px">Visible line<br>Hidden sentinel</p></div>',
    async (page, directory) => {
      const state = (await observe(page, 0, join(directory, 'partial.png')))
        .visibleViewport;
      assert.match(state.text, /Visible line/);
      assert.doesNotMatch(state.text, /Hidden sentinel/);
    },
  );
});

test('modal background controls and fully covered content are excluded', async () => {
  await fixture(
    '<a href="/destination">Background destination</a><p>Covered sentinel</p><div style="position:absolute;top:30px;left:0;width:100%;height:70px;background:white">Cover</div><dialog><button>Close</button></dialog>',
    async (page, directory) => {
      let state = (await observe(page, 0, join(directory, 'covered.png')))
        .visibleViewport;
      assert.doesNotMatch(state.text, /Covered sentinel/);
      await page
        .locator('dialog')
        .evaluate((element) => (element as HTMLDialogElement).showModal());
      state = (await observe(page, 1, join(directory, 'modal.png')))
        .visibleViewport;
      assert.match(state.text, /Close/);
      assert.doesNotMatch(state.text, /Background destination/);
      assert.equal(
        state.controls.some(
          (control) => control.name === 'Background destination',
        ),
        false,
      );
      assert.equal(
        (await candidates(page, journey, baseURL)).some(
          (action) => action.kind === 'link',
        ),
        false,
      );
    },
  );
});

test('visible shadow controls are included and password values are excluded', async () => {
  await fixture(
    '<div id="host"></div><input type="password" value="private-sentinel" aria-label="Password">',
    async (page, directory) => {
      await page.locator('#host').evaluate((element) => {
        element.attachShadow({ mode: 'open' }).innerHTML =
          '<a href="/destination">Shadow destination</a>';
      });
      const state = (await observe(page, 0, join(directory, 'shadow.png')))
        .visibleViewport;
      assert.match(state.text, /Shadow destination/);
      assert.equal(
        state.controls.some((control) => control.name === 'Shadow destination'),
        true,
      );
      assert.doesNotMatch(JSON.stringify(state), /private-sentinel/);
      assert.equal(
        (await candidates(page, journey, baseURL)).some(
          (action) => action.kind === 'link',
        ),
        true,
      );
    },
  );
});

test('scroll candidates reflect the nested container under the wheel position', async () => {
  await fixture(
    '<style>body{margin:0}</style><main style="height:800px;overflow:auto;overscroll-behavior:contain"><div style="height:1600px">Long panel</div></main>',
    async (page, directory) => {
      assert.equal(
        (await observe(page, 0, join(directory, 'top.png'))).visibleViewport
          .canScrollDown,
        true,
      );
      assert.deepEqual(
        (await candidates(page, journey, baseURL))
          .filter((action) => action.kind === 'scroll')
          .map((action) => action.direction),
        ['down'],
      );
      await page.locator('main').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const bottom = (await observe(page, 1, join(directory, 'bottom.png')))
        .visibleViewport;
      assert.equal(bottom.canScrollDown, false);
      assert.equal(bottom.canScrollUp, true);
      assert.deepEqual(
        (await candidates(page, journey, baseURL))
          .filter((action) => action.kind === 'scroll')
          .map((action) => action.direction),
        ['up'],
      );
      await page.setContent('<p>A short page</p>');
      assert.equal(
        (await candidates(page, journey, baseURL)).some(
          (action) => action.kind === 'scroll',
        ),
        false,
      );
    },
  );
});
