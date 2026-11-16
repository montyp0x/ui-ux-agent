import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { explainCheck } from '../src/browser.js';
import type { Check } from '../src/contracts.js';

const PAGE = `<header><h1>Home</h1></header>
<p class="twice">One</p><p class="twice">Two</p>
<p id="hidden" hidden>Hidden</p>
<div style="height:3000px"></div><p id="below">Below the fold</p>`;

test('a failed condition says what the page has instead', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route('https://explain.example/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: PAGE }),
    );
    await page.goto('https://explain.example/start');
    const css = (value: string) => ({ by: 'css', value }) as const;
    const cases: [Check, string | null][] = [
      // Holds: nothing to explain.
      [{ kind: 'visible', target: { by: 'role', role: 'heading', name: 'Home' } }, null],
      [{ kind: 'visible', target: css('main') }, 'css "main" matches no element on the page'],
      [
        { kind: 'visible', target: { by: 'role', role: 'heading', name: 'Welcome' } },
        'heading "Welcome" matches no element on the page',
      ],
      [{ kind: 'visible', target: css('.twice') }, 'css ".twice" matches 2 elements; it must match exactly one'],
      [{ kind: 'anyVisible', target: css('.twice') }, null],
      [{ kind: 'visible', target: css('#hidden') }, 'css "#hidden" matches an element that is not visible'],
      [
        { kind: 'visible', target: css('#below') },
        'css "#below" is outside the viewport or covered (anyRendered accepts it anywhere on the page)',
      ],
      [{ kind: 'anyRendered', target: css('#below') }, null],
      [{ kind: 'notVisible', target: css('header') }, 'css "header" is visible'],
      [
        { kind: 'path', pattern: '^/home$' },
        'the page path is /start, which ^/home$ does not match',
      ],
      // A text pattern that does not match is the condition itself.
      [{ kind: 'text', target: css('header'), pattern: '^Away$' }, null],
    ];
    for (const [condition, expected] of cases)
      assert.equal(
        await explainCheck(page, condition),
        expected,
        JSON.stringify(condition),
      );
  } finally {
    await browser.close();
  }
});
