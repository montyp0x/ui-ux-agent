import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import {
  activeExceptions,
  combineStatus,
  expandBreakpoints,
  layoutAuditConfigSchema,
  type LayoutAuditConfigInput,
  type LayoutAuditResult,
  type LayoutRule,
} from '../src/audits/layout.js';
import {
  auditAtBreakpoints,
  auditLayout,
  auditLayoutMatrix,
} from '../src/drivers/playwright-layout.js';
import {
  clippedLabel,
  iconToolbar,
  intentionalOverlap,
  stickyBanner,
} from './layout-fixtures.js';

const MATRIX = expandBreakpoints({
  breakpoints: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
  ],
});

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

function sweep(html: string, config: LayoutAuditConfigInput = {}) {
  return auditLayoutMatrix({
    browser,
    breakpoints: MATRIX,
    config,
    open: (page) => page.setContent(html),
  });
}

function detector(result: LayoutAuditResult, rule: LayoutRule) {
  const found = result.detectors.find((entry) => entry.rule === rule);
  assert.ok(found, `${rule} ran`);
  return found;
}

// Breakpoint names where the rule reported findings.
function affected(results: LayoutAuditResult[], rule: LayoutRule): string[] {
  return results
    .filter((result) => detector(result, rule).findings.length)
    .map((result) => result.breakpoint!.name);
}

function assertClean(results: LayoutAuditResult[]) {
  for (const result of results) {
    assert.equal(result.status, 'clean', result.breakpoint!.name);
    for (const entry of result.detectors) {
      assert.equal(
        entry.status,
        'clean',
        `${result.breakpoint!.name} ${entry.rule}`,
      );
      assert.ok(entry.checked > 0, `${entry.rule} measured something`);
    }
  }
}

test('breakpoint matrix adds the 400% zoom reflow case as a 320x256 CSS viewport', () => {
  assert.deepEqual(
    MATRIX.map(({ name, width, height, kind, zoom }) => [
      name,
      width,
      height,
      kind,
      zoom,
    ]),
    [
      ['desktop', 1280, 800, 'viewport', null],
      ['tablet', 768, 1024, 'viewport', null],
      ['mobile', 390, 844, 'viewport', null],
      ['reflow-400', 320, 256, 'reflow', 4],
    ],
  );
  // Suite viewports are the default declared widths; zoom is configurable.
  const fromSuite = expandBreakpoints({ reflow: { zoom: 2 } }, [
    { name: 'narrow', width: 390, height: 844 },
  ]);
  assert.deepEqual(
    fromSuite.map(({ name, width, height }) => [name, width, height]),
    [
      ['narrow', 390, 844],
      ['reflow-200', 640, 512],
    ],
  );
  assert.deepEqual(
    expandBreakpoints({
      breakpoints: [
        { name: 'hidpi', width: 390, height: 844, deviceScaleFactor: 3 },
      ],
      reflow: false,
    }).map(({ name, deviceScaleFactor }) => [name, deviceScaleFactor]),
    [['hidpi', 3]],
  );
  assert.throws(
    () =>
      expandBreakpoints({
        breakpoints: [{ name: 'reflow-400', width: 320, height: 256 }],
      }),
    /unique/,
  );
  assert.throws(() => expandBreakpoints({}), /breakpoints or suite viewports/);
});

test('config defaults follow WCAG 2.2 target size and reject unknown keys', () => {
  const config = layoutAuditConfigSchema.parse({});
  assert.deepEqual(config.rules, ['clipping', 'occlusion', 'target-size']);
  assert.equal(config.targetSize.minimum, 24);
  assert.equal(config.clipping.tolerancePx, 1);
  assert.equal(config.occlusion.minCoveredFraction, 0.3);
  assert.equal(
    layoutAuditConfigSchema.parse({ targetSize: { minimum: 44 } }).targetSize
      .minimum,
    44,
  );
  assert.throws(() =>
    layoutAuditConfigSchema.parse({
      exceptions: [{ rule: 'clipping', selector: '.x' }],
    }),
  );
  assert.throws(() =>
    layoutAuditConfigSchema.parse({ clipping: { tolerance: 2 } }),
  );
});

test('status never reads clean when a detector errored or coverage is missing', () => {
  assert.equal(combineStatus(['clean', 'error', 'findings']), 'error');
  assert.equal(combineStatus(['clean', 'incomplete']), 'incomplete');
  assert.equal(combineStatus(['incomplete', 'findings']), 'findings');
  assert.equal(combineStatus(['clean', 'unsupported']), 'unsupported');
  assert.equal(combineStatus([]), 'incomplete');
  const exceptions = layoutAuditConfigSchema.parse({
    exceptions: [
      { rule: 'clipping', selector: '.a', reason: 'everywhere' },
      {
        rule: 'clipping',
        selector: '.b',
        reason: 'mobile only',
        breakpoints: ['mobile'],
      },
    ],
  }).exceptions;
  assert.deepEqual(
    activeExceptions(exceptions, { name: 'desktop' }).map((e) => e.index),
    [0],
  );
  assert.deepEqual(
    activeExceptions(exceptions, { name: 'mobile' }).map((e) => e.index),
    [0, 1],
  );
});

test('a label clipped by its overflow-hidden box is found at narrow widths only', async () => {
  const results = await sweep(clippedLabel.defect);
  assert.deepEqual(affected(results, 'clipping'), ['mobile', 'reflow-400']);
  assert.deepEqual(affected(results, 'occlusion'), []);
  assert.deepEqual(affected(results, 'target-size'), []);
  const finding = detector(results[2]!, 'clipping').findings[0]!;
  assert.equal(finding.rule, 'clipping');
  if (finding.rule !== 'clipping') return;
  assert.equal(finding.selector, 'body > main > form > div > label');
  assert.equal(finding.overflowX, 'hidden');
  assert.equal(finding.clipBox.width, 110);
  assert.equal(finding.items.length, 1);
  const [item] = finding.items;
  assert.equal(item!.kind, 'text');
  assert.equal(item!.excerpt, 'Email address for invoices');
  assert.ok(item!.cut.right > 40, `cut ${item!.cut.right}px`);
  assert.equal(item!.cut.left, 0);
  assert.ok(item!.visibleFraction < 0.7);
  assert.equal(finding.maxCutPx, item!.cut.right);
  assert.match(
    finding.description,
    /cut off by up to [\d.]+px at the right edge/,
  );
  assertClean(await sweep(clippedLabel.corrected));
});

test('a fixed banner covering the submit button is found where it covers it', async () => {
  const required: LayoutAuditConfigInput = {
    requiredControls: [{ by: 'role', role: 'button', name: 'Place order' }],
  };
  const results = await sweep(stickyBanner.defect, required);
  assert.deepEqual(affected(results, 'occlusion'), ['mobile', 'reflow-400']);
  const finding = detector(results[2]!, 'occlusion').findings[0]!;
  assert.equal(finding.rule, 'occlusion');
  if (finding.rule !== 'occlusion') return;
  assert.equal(finding.name, 'Place order');
  assert.equal(finding.required, true);
  assert.equal(finding.cover.layer, 'body > div');
  assert.equal(finding.centerCovered, true);
  assert.equal(finding.covered, 9);
  assert.equal(finding.coveredFraction, 1);
  assert.deepEqual(finding.cover.box, {
    x: 0,
    y: 664,
    width: 390,
    height: 180,
  });
  // Only the required control is checked when one is configured.
  assert.equal(detector(results[2]!, 'occlusion').checked, 1);
  // Without required controls every interactive control is checked, and the
  // name field the sheet also covers is reported too.
  const all = await sweep(stickyBanner.defect);
  assert.deepEqual(
    detector(all[2]!, 'occlusion').findings.map((entry) => entry.selector),
    ['#name', 'body > main > form > button'],
  );
  assertClean(await sweep(stickyBanner.corrected, required));
  assertClean(await sweep(stickyBanner.corrected));
});

test('the occlusion check restores the scroll position it moved', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<div style="height:1500px"></div><button style="height:44px;width:120px">Far below</button><div style="height:1500px"></div>',
    );
    await page.evaluate(() => window.scrollTo(0, 120));
    const result = await auditLayout(page, { rules: ['occlusion'] });
    assert.equal(result.status, 'clean');
    assert.equal(detector(result, 'occlusion').checked, 1);
    assert.equal(await page.evaluate(() => window.scrollY), 120);
  } finally {
    await context.close();
  }
});

test('icon buttons below 24px are found on mobile; inline and labelled targets are visibly exempt', async () => {
  const results = await sweep(iconToolbar.defect);
  assert.deepEqual(affected(results, 'target-size'), ['mobile', 'reflow-400']);
  const sizes = detector(results[2]!, 'target-size');
  assert.deepEqual(
    sizes.findings.map((entry) =>
      entry.rule === 'target-size'
        ? [entry.name, entry.width, entry.height]
        : [],
    ),
    [
      ['Bold', 16, 16],
      ['Italic', 16, 16],
      ['Underline', 16, 16],
      ['Link', 16, 16],
    ],
  );
  // WCAG 2.5.8 exceptions are listed with the measurement they suppressed.
  assert.deepEqual(
    sizes.exempted.map((entry) => [entry.selector, entry.exemption.kind]),
    [
      ['#editor > p > a', 'inline'],
      ['#editor > label > input', 'equivalent-label'],
    ],
  );
  assert.ok(
    sizes.exempted.every((entry) => entry.measured.rule === 'target-size'),
  );
  // The sr-only skip link is not a rendered target.
  assert.equal(sizes.skipped['visually-hidden'], 1);
  // 44px (WCAG 2.5.5) is opt-in and has no spacing exception.
  const strict = await sweep(iconToolbar.corrected, {
    rules: ['target-size'],
    targetSize: { minimum: 44 },
  });
  assert.deepEqual(affected(strict, 'target-size'), [
    'desktop',
    'tablet',
    'mobile',
    'reflow-400',
  ]);
  assertClean(await sweep(iconToolbar.corrected));
});

test('a small target clear of its neighbours passes under the spacing exception', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<button aria-label="Close" style="width:16px;height:16px;padding:0;margin:40px"></button><button style="width:120px;height:44px">Continue</button>',
    );
    const spaced = detector(
      await auditLayout(page, { rules: ['target-size'] }),
      'target-size',
    );
    assert.equal(spaced.status, 'clean');
    assert.deepEqual(
      spaced.exempted.map((entry) => entry.exemption.kind),
      ['spacing'],
    );
    const strict = detector(
      await auditLayout(page, {
        rules: ['target-size'],
        targetSize: { spacingExemption: false },
      }),
      'target-size',
    );
    assert.equal(strict.status, 'findings');
  } finally {
    await context.close();
  }
});

test('intentional layouts are exempted narrowly and visibly', async () => {
  // Unexempted, the carousel, the art over the CTA, the dots and the promo
  // label are all reported.
  const plain = await sweep(intentionalOverlap);
  for (const result of plain) {
    assert.deepEqual(
      detector(result, 'clipping').findings.map((entry) => entry.selector),
      ['body > div:nth-of-type(1)', 'body > p'],
    );
    assert.deepEqual(
      detector(result, 'occlusion').findings.map((entry) => entry.selector),
      ['body > section > a'],
    );
    assert.equal(detector(result, 'target-size').findings.length, 3);
  }
  const results = await sweep(intentionalOverlap, {
    exceptions: [
      {
        rule: 'clipping',
        selector: '.carousel',
        reason: 'Carousel shows one slide at a time',
      },
      {
        rule: 'occlusion',
        selector: '.hero-art',
        reason: 'Decorative art overlaps the CTA by design',
      },
      {
        rule: 'target-size',
        selector: '.dots',
        reason: 'Dots duplicate swipe on touch screens',
        breakpoints: ['mobile'],
      },
      {
        rule: 'occlusion',
        selector: '.not-on-this-page',
        reason: 'Stale exception',
      },
    ],
  });
  for (const result of results) {
    const name = result.breakpoint!.name;
    const clipping = detector(result, 'clipping');
    // The promo label outside the carousel is still clipped and reported.
    assert.deepEqual(
      clipping.findings.map((entry) => entry.selector),
      ['body > p'],
      name,
    );
    assert.deepEqual(
      clipping.exempted.map((entry) => [
        entry.selector,
        entry.exemption.kind === 'exception' && entry.exemption.index,
      ]),
      [['body > div:nth-of-type(1)', 0]],
    );
    const carousel = clipping.exempted[0]!;
    assert.equal(
      carousel.exemption.kind === 'exception' && carousel.exemption.matchedOn,
      'subject',
    );
    assert.equal(carousel.measured.rule, 'clipping');
    if (carousel.measured.rule === 'clipping')
      assert.match(
        carousel.measured.items.map((item) => item.excerpt).join(' '),
        /Works offline/,
      );
    const occlusion = detector(result, 'occlusion');
    assert.deepEqual(occlusion.findings, [], name);
    assert.deepEqual(
      occlusion.exempted.map((entry) => [
        entry.selector,
        entry.exemption.kind === 'exception' && entry.exemption.matchedOn,
        entry.measured.rule === 'occlusion' && entry.measured.cover.layer,
      ]),
      [['body > section > a', 'cover', 'body > section > div']],
    );
    // The breakpoint-scoped dots exception applies on mobile only.
    const sizes = detector(result, 'target-size');
    assert.equal(sizes.findings.length, name === 'mobile' ? 0 : 3, name);
    assert.equal(sizes.exempted.length, name === 'mobile' ? 3 : 0, name);
    assert.equal(result.status, 'findings');
    // The ledger shows which exceptions were in force and used.
    assert.deepEqual(
      result.exceptions.map((entry) => [
        entry.index,
        entry.active,
        entry.uses > 0,
      ]),
      [
        [0, true, true],
        [1, true, true],
        [2, name === 'mobile', name === 'mobile'],
        [3, true, false],
      ],
    );
  }
});

test('declared truncation is a review candidate, not a finding', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<p style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long product title that does not fit</p><p style="width:200px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2">One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen</p>',
    );
    const clipping = detector(
      await auditLayout(page, { rules: ['clipping'] }),
      'clipping',
    );
    assert.equal(clipping.status, 'clean');
    assert.deepEqual(clipping.findings, []);
    assert.deepEqual(
      clipping.reviewCandidates.map((entry) => [entry.selector, entry.kind]),
      [
        ['body > p:nth-of-type(1)', 'truncation-ellipsis'],
        ['body > p:nth-of-type(2)', 'line-clamp'],
      ],
    );
  } finally {
    await context.close();
  }
});

test('detector failures are errors, never clean', async () => {
  // An invalid exception selector fails its own detector only.
  const invalid = await sweep(clippedLabel.corrected, {
    exceptions: [{ rule: 'clipping', selector: '[[bad', reason: 'typo' }],
  });
  for (const result of invalid) {
    assert.equal(result.status, 'error');
    assert.equal(detector(result, 'clipping').status, 'error');
    assert.match(
      detector(result, 'clipping').error!,
      /Invalid exception selector #0/,
    );
    assert.equal(detector(result, 'target-size').status, 'clean');
  }
  // A page that breaks hit testing fails occlusion.
  const hostile = await sweep(
    `${stickyBanner.corrected}<script>document.elementFromPoint=()=>{throw new Error('hit testing unavailable')}</script>`,
  );
  for (const result of hostile) {
    assert.equal(detector(result, 'occlusion').status, 'error');
    assert.match(
      detector(result, 'occlusion').error!,
      /hit testing unavailable/,
    );
    assert.equal(result.status, 'error');
  }
  // An unresolvable required control fails occlusion; a missing one leaves
  // it incomplete.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(stickyBanner.corrected);
    const unresolvable = await auditLayout(page, {
      rules: ['occlusion'],
      requiredControls: [{ by: 'css', value: '[[bad' }],
    });
    assert.equal(unresolvable.status, 'error');
    assert.match(
      detector(unresolvable, 'occlusion').error!,
      /could not be resolved/,
    );
    const missing = await auditLayout(page, {
      rules: ['occlusion'],
      requiredControls: [{ by: 'role', role: 'button', name: 'Pay now' }],
    });
    assert.equal(missing.status, 'incomplete');
    assert.deepEqual(detector(missing, 'occlusion').incomplete, [
      'Required control #0 (button "Pay now") was not found',
    ]);
    // A page that is gone yields an error result for every rule.
    await page.close();
    const closed = await auditLayout(page, {});
    assert.equal(closed.status, 'error');
    assert.deepEqual(
      closed.detectors.map((entry) => entry.status),
      ['error', 'error', 'error'],
    );
    assert.match(closed.detail!, /Layout audit failed/);
  } finally {
    await context.close();
  }
  // A page that cannot be opened is an error at that breakpoint.
  const unopened = await auditLayoutMatrix({
    browser,
    breakpoints: MATRIX.slice(0, 1),
    config: {},
    async open() {
      throw new Error('fixture unavailable');
    },
  });
  assert.equal(unopened[0]!.status, 'error');
  assert.match(unopened[0]!.detail!, /fixture unavailable/);
});

test('a breakpoint sweep on a live page restores its viewport and reports pixel ratios it cannot emulate', async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(clippedLabel.defect);
    const breakpoints = [
      ...MATRIX,
      ...expandBreakpoints({
        breakpoints: [
          { name: 'hidpi', width: 390, height: 844, deviceScaleFactor: 3 },
        ],
        reflow: false,
      }),
    ];
    const results = await auditAtBreakpoints(page, breakpoints, {});
    assert.deepEqual(
      results.map((result) => [result.breakpoint!.name, result.status]),
      [
        ['desktop', 'clean'],
        ['tablet', 'clean'],
        ['mobile', 'findings'],
        ['reflow-400', 'findings'],
        ['hidpi', 'unsupported'],
      ],
    );
    assert.match(results[4]!.detail!, /needs a new browser context/);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 800 });
    assert.equal(await page.evaluate(() => window.innerWidth), 1280);
    // A fresh context per breakpoint does emulate the ratio.
    const [hidpi] = await auditLayoutMatrix({
      browser,
      breakpoints: breakpoints.slice(4),
      config: {},
      open: (fresh) => fresh.setContent(clippedLabel.defect),
    });
    assert.equal(hidpi!.viewport!.devicePixelRatio, 3);
    assert.equal(hidpi!.status, 'findings');
  } finally {
    await context.close();
  }
});
