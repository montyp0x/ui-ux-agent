import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import {
  ACCESSIBILITY_SCAN_LIMITATIONS,
  MAX_HTML_LENGTH,
  MAX_NODES_PER_RULE,
  parseAxeResults,
  type AccessibilityScan,
} from '../src/audits/accessibility.js';
import { scanAccessibility } from '../src/drivers/playwright-axe.js';
import {
  accessibilityFixtures,
  contrastNeedsReview,
} from './fixtures/accessibility.js';

const baseURL = 'https://fixture.example';
let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

async function withPage<T>(html: string, run: (page: Page) => Promise<T>) {
  const page = await browser.newPage();
  try {
    await page.route(`${baseURL}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto(`${baseURL}/`);
    return await run(page);
  } finally {
    await page.close();
  }
}

function completed(scan: AccessibilityScan) {
  assert.equal(
    scan.status,
    'completed',
    scan.status === 'error' ? `${scan.error.kind}: ${scan.error.message}` : '',
  );
  return scan as Extract<AccessibilityScan, { status: 'completed' }>;
}

function failed(scan: AccessibilityScan) {
  assert.equal(scan.status, 'error');
  return scan as Extract<AccessibilityScan, { status: 'error' }>;
}

const ruleIds = (rules: { ruleId: string }[]) =>
  rules.map((rule) => rule.ruleId).sort();

for (const [name, fixture] of Object.entries(accessibilityFixtures)) {
  test(`${name}: the broken page reports exactly its known violations`, async () => {
    const scan = completed(
      await withPage(fixture.broken, (page) => scanAccessibility(page)),
    );
    assert.deepEqual(ruleIds(scan.violations), [...fixture.violations].sort());
    assert.equal(scan.analyzer.name, 'axe-core');
    assert.match(scan.analyzer.version ?? '', /^\d+\.\d+\.\d+/);
    assert.equal(scan.url, `${baseURL}/`);
    for (const violation of scan.violations) {
      assert.ok(violation.impact, `${violation.ruleId} has an impact`);
      assert.ok(violation.help.length > 0);
      assert.match(violation.helpUrl, /^https:\/\//);
      assert.ok(
        violation.wcag.length > 0 &&
          violation.wcag.every((tag) => violation.tags.includes(tag)),
        `${violation.ruleId} carries its WCAG tags`,
      );
      assert.ok(violation.nodeCount >= 1);
      for (const node of violation.nodes) {
        assert.ok(node.target.length >= 1 && node.target[0]!.length > 0);
        assert.match(node.html, /^</);
        assert.ok(node.messages.length > 0, 'a node says why it failed');
      }
    }
    assert.ok(scan.passedRules > 0);
  });

  test(`${name}: the corrected twin has no violations and nothing to review`, async () => {
    const scan = completed(
      await withPage(fixture.fixed, (page) => scanAccessibility(page)),
    );
    assert.deepEqual(scan.violations, []);
    assert.deepEqual(scan.incomplete, []);
  });
}

test('contrast the analyzer cannot compute is incomplete, never a pass or a violation', async () => {
  const scan = completed(
    await withPage(contrastNeedsReview, (page) => scanAccessibility(page)),
  );
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(ruleIds(scan.incomplete), ['color-contrast']);
  const [review] = scan.incomplete;
  assert.equal(review!.nodeCount, 1);
  assert.match(review!.nodes[0]!.messages.join(' '), /background/i);
  assert.deepEqual(review!.wcag.sort(), ['wcag143', 'wcag2aa']);
});

const regions = `<!doctype html><html lang="en"><head><title>Regions</title></head><body><main><h1>Regions</h1>
<section id="clean"><h2>Clean</h2><button type="button">Save</button></section>
<section id="broken"><h2>Broken</h2><button type="button"></button></section></main></body></html>`;

test('a scoped scan covers only the configured region', async () => {
  await withPage(regions, async (page) => {
    const whole = completed(await scanAccessibility(page));
    assert.deepEqual(ruleIds(whole.violations), ['button-name']);
    const clean = completed(
      await scanAccessibility(page, { include: ['#clean'] }),
    );
    assert.deepEqual(clean.violations, []);
    assert.deepEqual(clean.scope, { include: ['#clean'], exclude: [] });
    const broken = completed(
      await scanAccessibility(page, { include: ['#broken'] }),
    );
    assert.deepEqual(ruleIds(broken.violations), ['button-name']);
    assert.deepEqual(broken.violations[0]!.nodes[0]!.target, [
      '#broken > button',
    ]);
    const excluded = completed(
      await scanAccessibility(page, { exclude: ['#broken'] }),
    );
    assert.deepEqual(excluded.violations, []);
  });
});

test('a rule-tag filter limits the scan to those rules', async () => {
  const scan = completed(
    await withPage(accessibilityFixtures.contrast.broken, (page) =>
      scanAccessibility(page, { tags: ['wcag2a'] }),
    ),
  );
  // color-contrast is a level AA rule, so a level A scan does not run it.
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.tags, ['wcag2a']);
});

test('a scope selector that matches nothing is an error, not a clean region', async () => {
  const scan = failed(
    await withPage(regions, (page) =>
      scanAccessibility(page, { include: ['#missing'] }),
    ),
  );
  assert.equal(scan.error.kind, 'scope_not_found');
  assert.match(scan.error.message, /#missing/);
  assert.ok(!('violations' in scan));
});

test('an analyzer exception is an error result', async () => {
  // A page that has taken the analyzer's global: injection cannot install axe.
  const hostile = `<!doctype html><html lang="en"><head><title>Hostile</title><script>Object.defineProperty(window, 'axe', { value: Object.freeze({}), writable: false, configurable: false });</script></head><body><main><h1>Hostile</h1></main></body></html>`;
  const scan = failed(
    await withPage(hostile, (page) => scanAccessibility(page)),
  );
  assert.equal(scan.error.kind, 'analyzer_exception');
  assert.ok(scan.error.message.length > 0);
});

test('a closed page is an analyzer exception', async () => {
  const page = await browser.newPage();
  await page.close();
  const scan = failed(await scanAccessibility(page));
  assert.equal(scan.error.kind, 'analyzer_exception');
});

test('a scan that runs past its deadline is a timeout error', async () => {
  const scan = failed(
    await withPage(accessibilityFixtures.semantics.broken, (page) =>
      scanAccessibility(page, { timeoutMs: 1 }),
    ),
  );
  assert.equal(scan.error.kind, 'timeout');
});

test('the scan opens no second page in the browser context', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const opened: string[] = [];
    // Sessions close every page other than the one under test.
    context.on('page', (other) => {
      opened.push(other.url());
      void other.close();
    });
    await page.route(`${baseURL}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: accessibilityFixtures.formLabels.broken,
      }),
    );
    await page.goto(`${baseURL}/`);
    const scan = completed(await scanAccessibility(page));
    assert.deepEqual(ruleIds(scan.violations), ['label', 'select-name']);
    assert.deepEqual(opened, []);
  } finally {
    await context.close();
  }
});

test('large results keep counts and a bounded sample', async () => {
  const long = 'x'.repeat(MAX_HTML_LENGTH * 2);
  const images = Array.from(
    { length: MAX_NODES_PER_RULE + 5 },
    (_, index) => `<img src="data:," data-note="${long}" id="i${index}">`,
  ).join('');
  const scan = completed(
    await withPage(
      `<!doctype html><html lang="en"><head><title>Many</title></head><body><main><h1>Many</h1>${images}</main></body></html>`,
      (page) => scanAccessibility(page),
    ),
  );
  const [imageAlt] = scan.violations.filter(
    (rule) => rule.ruleId === 'image-alt',
  );
  assert.equal(imageAlt!.nodeCount, MAX_NODES_PER_RULE + 5);
  assert.equal(imageAlt!.nodes.length, MAX_NODES_PER_RULE);
  assert.equal(imageAlt!.nodesTruncated, true);
  // axe-core shortens snippets itself; the parser's bound is the backstop.
  assert.ok(imageAlt!.nodes[0]!.html.length <= MAX_HTML_LENGTH);
});

const context = { scope: { include: [], exclude: [] }, tags: [], durationMs: 5 };
const rawRule = {
  id: 'button-name',
  impact: 'critical',
  tags: ['cat.name-role-value', 'wcag2a', 'wcag412', 'section508'],
  description: 'Ensure buttons have discernible text',
  help: 'Buttons must have discernible text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/button-name',
  nodes: [
    {
      html: '<button></button>',
      target: ['main', ['my-widget', 'button']],
      impact: 'critical',
      any: [{ id: 'button-has-visible-text', message: 'No visible text' }],
      all: [],
      none: [],
    },
  ],
};
const rawResults = {
  testEngine: { name: 'axe-core', version: '4.14.0' },
  url: 'https://fixture.example/',
  violations: [rawRule],
  incomplete: [],
  passes: [{ id: 'html-has-lang' }],
  inapplicable: [],
};

test('raw analyzer output is parsed into the typed result', () => {
  const scan = completed(
    parseAxeResults(rawResults, 'https://fixture.example/', context),
  );
  const [rule] = scan.violations;
  assert.deepEqual(rule!.wcag, ['wcag2a', 'wcag412']);
  // Frame levels stay separate entries; a shadow-DOM chain is joined.
  assert.deepEqual(rule!.nodes[0]!.target, ['main', 'my-widget >> button']);
  assert.deepEqual(rule!.nodes[0]!.messages, ['No visible text']);
  assert.equal(scan.passedRules, 1);
});

test('the parser bounds HTML snippets the analyzer did not shorten', () => {
  const html = `<button data-note="${'x'.repeat(MAX_HTML_LENGTH * 2)}"></button>`;
  const scan = completed(
    parseAxeResults(
      {
        ...rawResults,
        violations: [{ ...rawRule, nodes: [{ ...rawRule.nodes[0], html }] }],
      },
      'https://fixture.example/',
      context,
    ),
  );
  const [node] = scan.violations[0]!.nodes;
  assert.equal(node!.htmlTruncated, true);
  assert.equal(node!.html, `${html.slice(0, MAX_HTML_LENGTH - 1)}…`);
  assert.equal(node!.html.length, MAX_HTML_LENGTH);
});

test('analyzer output that does not match its documented shape is an error, never clean', () => {
  for (const raw of [
    null,
    'not results',
    {},
    { ...rawResults, violations: 'none' },
    { ...rawResults, violations: [{ ...rawRule, impact: 'catastrophic' }] },
    { ...rawResults, violations: [{ ...rawRule, id: '' }] },
    { ...rawResults, testEngine: { name: 'other-engine', version: '1.0.0' } },
  ]) {
    const scan = failed(
      parseAxeResults(raw, 'https://fixture.example/', context),
    );
    assert.equal(scan.error.kind, 'invalid_output');
  }
});

test('every result states what an automated scan does not establish', async () => {
  const clean = completed(
    await withPage(accessibilityFixtures.formLabels.fixed, (page) =>
      scanAccessibility(page),
    ),
  );
  const error = failed(
    parseAxeResults(null, 'https://fixture.example/', context),
  );
  for (const scan of [clean, error]) {
    assert.deepEqual(scan.limitations, [...ACCESSIBILITY_SCAN_LIMITATIONS]);
    const text = scan.limitations.join(' ');
    assert.match(text, /does not establish WCAG conformance/);
    assert.match(text, /Keyboard operation and focus order are not tested/);
    assert.doesNotMatch(
      JSON.stringify(scan),
      /\b(is|are|fully) (WCAG[- ])?(compliant|conformant|certified)\b/i,
    );
  }
});
