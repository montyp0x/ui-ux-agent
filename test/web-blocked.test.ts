import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates } from '../src/browser.js';
import { journeySchema, type Action } from '../src/contracts.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://blocked.example';
const journey = (extra: Record<string, unknown> = {}) =>
  journeySchema.parse({
    ...starterSuite(baseURL, '/goal').journeys[0]!,
    allowedPaths: ['/', '/account'],
    discoverRoles: ['button', 'tab'],
    ...extra,
  });

// Controls with side effects next to ordinary page actions that share words
// with them (close, pause, sort order, order history).
const PAGE = `<main><h1>Account</h1>
<button>Delete account</button><button>Save changes</button><button>Upgrade plan</button>
<button>Sort order</button><button>Close</button><button>Pause video</button><button>Open filters</button>
<div role="tablist"><button role="tab">Profile</button><button role="tab">Order history</button></div>
<details><summary>Reset all settings</summary><p>x</p></details>
<details><summary>Shipping</summary><p>y</p></details>
<a id="in" href="/account/plans">Plans</a> <a id="out" href="/elsewhere">Elsewhere</a> <a id="signout" href="/account/end">Sign out</a>
</main>`;

async function fixture(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(`${baseURL}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: PAGE }),
    );
    await page.goto(`${baseURL}/`);
    await run(page);
  } finally {
    await browser.close();
  }
}

const clicks = (actions: Action[]) =>
  actions.flatMap((action) =>
    action.kind === 'click' ? [action.description] : [],
  );

test('discovered controls with side effects are never offered on the web, unless configured', async () => {
  await fixture(async (page) => {
    const logged: { event: string; data: Record<string, unknown> }[] = [];
    const offered = await candidates(
      page,
      journey(),
      baseURL,
      [],
      async (event, data) => {
        logged.push({ event, data: data as Record<string, unknown> });
      },
      // The suite adds its own pattern.
      ['\\bfilters\\b'],
    );
    assert.deepEqual(clicks(offered), [
      'Click button Sort order',
      'Click button Close',
      'Click button Pause video',
      'Click tab Profile',
      'Click tab Order history',
      'Expand Shipping',
    ]);
    assert.deepEqual(
      logged
        .filter((entry) => entry.data.reason === 'blocked')
        .map((entry) => entry.data.name),
      [
        'Delete account',
        'Save changes',
        'Upgrade plan',
        'Open filters',
        'Reset all settings',
      ],
    );
    // A control the suite configures explicitly is offered.
    const configured = await candidates(
      page,
      journey({
        interactions: [
          {
            kind: 'click',
            target: { by: 'role', role: 'button', name: 'Save changes' },
            description: 'Save the profile',
          },
        ],
      }),
      baseURL,
    );
    assert.ok(clicks(configured).includes('Save the profile'));
  });
});

const keys = (actions: Action[]) =>
  actions.flatMap((action) => (action.kind === 'key' ? [action.key] : []));

test('a keyboard journey cannot activate a blocked control or leave its scope with Enter', async () => {
  await fixture(async (page) => {
    const keyboard = journey({ input: 'keyboard', discoverRoles: [] });
    const focusOn = async (selector: string) => {
      await page.locator(selector).focus();
      return keys(await candidates(page, keyboard, baseURL));
    };
    // Ordinary controls and in-scope links keep every key.
    for (const selector of ['button:text("Sort order")', '#in']) {
      const offered = await focusOn(selector);
      assert.ok(offered.includes('Enter') && offered.includes('Space'), selector);
    }
    // A blocked control: neither key that activates it.
    const blocked = await focusOn('button:text("Delete account")');
    assert.ok(!blocked.includes('Enter') && !blocked.includes('Space'));
    assert.ok(blocked.includes('Tab'));
    // Links out of scope, or for signing out: no Enter (Space scrolls).
    for (const selector of ['#out', '#signout']) {
      const offered = await focusOn(selector);
      assert.ok(!offered.includes('Enter'), selector);
      assert.ok(offered.includes('Space'), selector);
    }
    // Configured on the control: its keys come back.
    await page.locator('button:text("Delete account")').focus();
    const configured = keys(
      await candidates(
        page,
        journey({
          input: 'keyboard',
          discoverRoles: [],
          interactions: [
            {
              kind: 'press',
              key: 'Enter',
              target: { by: 'role', role: 'button', name: 'Delete account' },
              description: 'Delete the test account',
            },
          ],
        }),
        baseURL,
      ),
    );
    assert.ok(configured.includes('Enter'));
  });
});
