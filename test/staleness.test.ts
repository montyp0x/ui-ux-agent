import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { candidates, execute, observe } from '../src/browser.js';
import { type Action } from '../src/contracts.js';
import { starterSuite } from '../src/scaffold.js';

const baseURL = 'https://fixture.example';
const journey = starterSuite(baseURL, '/destination').journeys[0]!;

async function fixture(run: (page: Page, directory: string) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.route('https://fixture.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Fixture</h1><p id="counter">Loading</p><a href="/destination">Destination</a>',
      }),
    );
    await page.goto(baseURL);
    await run(page, await mkdtemp(join(tmpdir(), 'ui-ux-staleness-')));
  } finally {
    await browser.close();
  }
}

async function offer(page: Page, directory: string, kind: Action['kind']) {
  const before = await observe(page, 0, join(directory, 'before.png'));
  const offered = await candidates(page, journey, baseURL);
  const action = offered.find((action) => action.kind === kind);
  assert.ok(action);
  return { before, action };
}

test('unrelated loading updates do not discard an unchanged link', async () => {
  await fixture(async (page, directory) => {
    const { before, action } = await offer(page, directory, 'link');
    await page.locator('#counter').evaluate((element) => {
      element.textContent = 'Loaded: 42';
    });
    await execute(page, action, before, journey, baseURL);
    assert.equal(new URL(page.url()).pathname, '/destination');
  });
});

test('a replacement with the same locator cannot inherit the selected action', async () => {
  await fixture(async (page, directory) => {
    const { before, action } = await offer(page, directory, 'link');
    await page.locator('a').evaluate((element) => {
      element.replaceWith(element.cloneNode(true));
    });
    await assert.rejects(
      execute(page, action, before, journey, baseURL),
      /Stale observation: selected target/,
    );
    assert.equal(new URL(page.url()).pathname, '/');
  });
});

test('a changed accessible meaning blocks a control even with a stable CSS locator', async () => {
  await fixture(async (page, directory) => {
    await page.setContent(
      '<button id="action" onclick="this.dataset.clicked=\"yes\"">Open report</button>',
    );
    const configured = {
      ...journey,
      interactions: [
        {
          kind: 'click' as const,
          target: { by: 'css' as const, value: '#action' },
          description: 'Open report',
        },
      ],
    };
    const before = await observe(page, 0, join(directory, 'before.png'));
    const action = (await candidates(page, configured, baseURL)).find(
      (action) => action.kind === 'click',
    )!;
    await page.locator('#action').evaluate((element) => {
      element.textContent = 'Delete report';
    });
    await assert.rejects(
      execute(page, action, before, configured, baseURL),
      /Stale observation: selected target/,
    );
    assert.equal(
      await page.locator('#action').getAttribute('data-clicked'),
      null,
    );
  });
});

test('removed, hidden, disabled or ambiguous controls cannot execute', async () => {
  await fixture(async (page, directory) => {
    const configured = {
      ...journey,
      interactions: [
        {
          kind: 'click' as const,
          target: { by: 'css' as const, value: '.action' },
          description: 'Open report',
        },
      ],
    };
    for (const mutation of ['removed', 'hidden', 'disabled', 'duplicate']) {
      await page.setContent(
        '<button class="action" onclick="document.body.dataset.clicked=\"yes\"">Open report</button>',
      );
      const before = await observe(page, 0, join(directory, 'before.png'));
      const action = (await candidates(page, configured, baseURL)).find(
        (action) => action.kind === 'click',
      )!;
      await page.locator('.action').evaluate((element, mutation) => {
        if (mutation === 'removed') element.remove();
        if (mutation === 'hidden')
          (element as HTMLElement).style.display = 'none';
        if (mutation === 'disabled')
          (element as HTMLButtonElement).disabled = true;
        if (mutation === 'duplicate') element.after(element.cloneNode(true));
      }, mutation);
      await assert.rejects(
        execute(page, action, before, configured, baseURL),
        /Stale observation/,
        mutation,
      );
      assert.equal(
        await page.locator('body').getAttribute('data-clicked'),
        null,
      );
    }
  });
});

test('navigation or a newly opened dialog invalidates a selected link', async () => {
  await fixture(async (page, directory) => {
    let selected = await offer(page, directory, 'link');
    await page.evaluate(() => {
      history.pushState({}, '', '/?changed=1');
    });
    await assert.rejects(
      execute(page, selected.action, selected.before, journey, baseURL),
      /Stale observation: navigation/,
    );
    await page.goto(baseURL);
    selected = await offer(page, directory, 'link');
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.textContent = 'Confirm something else';
      document.body.append(dialog);
      dialog.showModal();
    });
    await assert.rejects(
      execute(page, selected.action, selected.before, journey, baseURL),
      /Stale observation: selected target/,
    );
    assert.equal(new URL(page.url()).pathname, '/');
  });
});

test('scroll accepts unrelated DOM changes but rejects a changed position or dialog', async () => {
  await fixture(async (page, directory) => {
    await page.setContent(
      '<p id="counter">Loading</p><main style="height:800px;overflow:auto"><div style="height:3000px">Long content</div></main>',
    );
    let selected = await offer(page, directory, 'scroll');
    await page.locator('#counter').evaluate((element) => {
      element.textContent = 'Ready';
    });
    await execute(page, selected.action, selected.before, journey, baseURL);
    const after = await observe(page, 1, join(directory, 'after.png'));
    assert.notDeepEqual(after.scroll, selected.before.scroll);
    selected = await offer(page, directory, 'scroll');
    await page.locator('main').evaluate((element) => {
      element.scrollTop += 100;
    });
    await assert.rejects(
      execute(page, selected.action, selected.before, journey, baseURL),
      /Stale observation: scroll container or position/,
    );
    selected = await offer(page, directory, 'scroll');
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.textContent = 'Another task';
      document.body.append(dialog);
      dialog.showModal();
    });
    await assert.rejects(
      execute(page, selected.action, selected.before, journey, baseURL),
      /Stale observation: scroll context/,
    );
  });
});

test('a wait tolerates loading completion', async () => {
  await fixture(async (page, directory) => {
    const { before, action } = await offer(page, directory, 'wait');
    await page.locator('#counter').evaluate((element) => {
      element.textContent = 'Ready';
    });
    await execute(page, action, before, journey, baseURL);
  });
});

test('changed form destinations and select options invalidate a stable control', async () => {
  await fixture(async (page, directory) => {
    await page.setContent(
      '<form action="/destination"><button id="submit">Search</button></form><select id="plan"><option value="annual">Annual</option></select>',
    );
    const configured = {
      ...journey,
      interactions: [
        {
          kind: 'click' as const,
          target: { by: 'css' as const, value: '#submit' },
          description: 'Search',
        },
        {
          kind: 'select' as const,
          target: { by: 'css' as const, value: '#plan' },
          description: 'Select annual',
          value: 'annual',
        },
      ],
    };
    let before = await observe(page, 0, join(directory, 'before-form.png'));
    let action: Action = (await candidates(page, configured, baseURL)).find(
      (action) => action.kind === 'click',
    )!;
    await page.locator('form').evaluate((element) => {
      (element as HTMLFormElement).action = '/other';
    });
    await assert.rejects(
      execute(page, action, before, configured, baseURL),
      /Stale observation: selected target/,
    );
    before = await observe(page, 0, join(directory, 'before-select.png'));
    action = (await candidates(page, configured, baseURL)).find(
      (action) => action.kind === 'select',
    )!;
    await page.locator('option').evaluate((element) => {
      element.textContent = 'Monthly';
    });
    await assert.rejects(
      execute(page, action, before, configured, baseURL),
      /Stale observation: selected target/,
    );
    assert.equal(new URL(page.url()).pathname, '/');
  });
});
