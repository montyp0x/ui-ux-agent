import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { candidates, execute, observe } from '../src/browser.js';
import { journeySchema, type Action } from '../src/contracts.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://disclosures.example';
const journey = (discoverRoles: string[]) =>
  journeySchema.parse({
    ...starterSuite(baseURL, '/goal').journeys[0]!,
    allowedPaths: ['/'],
    discoverRoles,
  });

// An FAQ built from <details>: two questions, and a summary text repeated in
// two disclosures (which one to toggle would be ambiguous).
const PAGE = `<main><h1>FAQ</h1>
<details><summary>Shipping times</summary><p>Two days.</p></details>
<details><summary>Returns <em>policy</em></summary><p>Thirty days.</p></details>
<details><summary>Cost ($) "per seat"?</summary><p>Ten.</p></details>
<details><summary>More</summary><p>A</p></details>
<details><summary>More</summary><p>B</p></details>
</main>`;

const toggles = (actions: Action[]) =>
  actions.flatMap((action) =>
    action.kind === 'click' ? [action.description] : [],
  );

test('a <details> summary is offered as a toggle with discovered buttons, and expands it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(`${baseURL}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: PAGE }),
    );
    await page.goto(`${baseURL}/`);
    // Not without discovered buttons: a summary toggles like one.
    assert.deepEqual(toggles(await candidates(page, journey([]), baseURL)), []);
    const offered = await candidates(page, journey(['button']), baseURL);
    assert.deepEqual(toggles(offered), [
      'Expand Shipping times',
      'Expand Returns policy',
      'Expand Cost ($) "per seat"?',
    ]);
    const before = await observe(
      page,
      0,
      join(await mkdtemp(join(tmpdir(), 'ui-ux-details-')), 'faq.png'),
    );
    await execute(
      page,
      offered.find((action) => action.description === 'Expand Shipping times')!,
      before,
      journey(['button']),
      baseURL,
    );
    assert.equal(await page.locator('details').first().getAttribute('open'), '');
    assert.ok(await page.getByText('Two days.').isVisible());
    assert.deepEqual(
      toggles(await candidates(page, journey(['button']), baseURL)),
      [
        'Collapse Shipping times',
        'Expand Returns policy',
        'Expand Cost ($) "per seat"?',
      ],
    );
  } finally {
    await browser.close();
  }
});
