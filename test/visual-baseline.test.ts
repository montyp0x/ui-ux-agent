// The visual.baseline audit: configuration, the comparison, threshold
// calibration on stable local fixtures, masks and evidence protection, and
// real journeys that capture, stay unapproved until an explicit approval,
// then match, mismatch or meet an incompatible baseline. Baselines are
// generated into temporary directories; no image is committed. No model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { auditConfigSchema } from '../src/audits/config.js';
import { auditOutputSchema } from '../src/audits/contract.js';
import {
  compareImages,
  DEFAULT_TOLERANCE,
  environmentDifferences,
  environmentId,
} from '../src/audits/visual.js';
import type { VisualEnvironment } from '../src/audits/visual-contract.js';
import {
  approveBaselines,
  assertOutsideGit,
  baselineDirectoryForRun,
  listBaselines,
} from '../src/baselines.js';
import { pruneRuns } from '../src/evidence/retention.js';
import {
  suiteSchema,
  type Action,
  type Choice,
  type Journey,
} from '../src/contracts.js';
import {
  MASK_COLOR,
  type ScreenshotProtection,
} from '../src/evidence/protection.js';
import { protectedScreenshot } from '../src/drivers/playwright-evidence.js';
import {
  stableCapture,
  visualBaselinePlaywrightAudit,
  visualMasks,
} from '../src/drivers/playwright-visual.js';
import type { Models } from '../src/models.js';
import { reportHTML } from '../src/report.js';
import type { Result } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import {
  article,
  done,
  ticker,
  type ArticleVariant,
} from './visual-fixtures.js';

const git = promisify(execFile);

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

// A local site whose pages the test changes between runs.
async function site() {
  const state: { start: () => string; done: () => string } = {
    start: () => article(),
    done: () => done(),
  };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/done' ? state.done() : state.start());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const tolerance = DEFAULT_TOLERANCE;
const settleDeadline = () => Date.now() + 20000;

// One capture of html in a fresh page, as the audit takes it.
async function capture(
  html: string,
  options: {
    mask?: string[];
    protection?: ScreenshotProtection;
    viewport?: { width: number; height: number };
  } = {},
): Promise<{ png: Buffer | null; captures: number }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 900, height: 700 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const masks = await visualMasks(page, options.mask ?? []);
    return await stableCapture(
      page,
      options.protection,
      masks.options,
      5,
      settleDeadline(),
    );
  } finally {
    await context.close();
  }
}

const pngOf = async (html: string, options?: Parameters<typeof capture>[1]) => {
  const { png } = await capture(html, options);
  assert.ok(png, 'the fixture settles');
  return png;
};

test('visual.baseline is configured per suite and validated strictly', () => {
  const parsed = auditConfigSchema.parse({ id: 'visual.baseline' });
  assert.equal(parsed.id, 'visual.baseline');
  if (parsed.id !== 'visual.baseline') return;
  assert.deepEqual(parsed.at, ['ready']);
  assert.deepEqual(parsed.mask, []);
  assert.equal(parsed.fullPage, false);
  assert.equal(parsed.threshold, 0.1);
  assert.equal(parsed.maxDiffPixels, 0);
  assert.equal(parsed.maxDiffRatio, 0);
  assert.equal(parsed.severity, 'serious');
  assert.equal(parsed.maxCaptures, 5);
  for (const invalid of [
    { id: 'visual.baseline', unknown: true },
    { id: 'visual.baseline', threshold: 2 },
    { id: 'visual.baseline', maxCaptures: 1 },
    { id: 'visual.baseline', mask: [''] },
    { id: 'visual.baseline', severity: 'blocker' },
  ])
    assert.throws(() => auditConfigSchema.parse(invalid));
});

const environment = (
  overrides: Partial<VisualEnvironment> = {},
): VisualEnvironment => ({
  viewport: { width: 1280, height: 800 },
  browser: {
    name: 'chromium',
    version: '140.0.1',
    build: 'bundled',
    headless: true,
  },
  os: { platform: 'darwin', arch: 'arm64', release: '24' },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezone: 'Europe/Berlin',
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  capture: { fullPage: false, masks: [], protected: false },
  ...overrides,
});

test('the compatibility key changes with every rendering field and names what differs', () => {
  const base = environment();
  assert.equal(environmentId(base), environmentId(environment()));
  const changed: [Partial<VisualEnvironment>, string][] = [
    [{ viewport: { width: 1200, height: 800 } }, 'viewport.width'],
    [{ browser: { ...base.browser, version: '141.0.0' } }, 'browser.version'],
    [{ browser: { ...base.browser, headless: false } }, 'browser.headless'],
    [{ os: { ...base.os, platform: 'linux' } }, 'os.platform'],
    [{ deviceScaleFactor: 2 }, 'deviceScaleFactor'],
    [{ locale: 'de-DE' }, 'locale'],
    [{ colorScheme: 'dark' }, 'colorScheme'],
    [{ capture: { ...base.capture, masks: ['#clock'] } }, 'capture.masks'],
    [{ capture: { ...base.capture, protected: true } }, 'capture.protected'],
  ];
  for (const [override, field] of changed) {
    const other = environment(override);
    assert.notEqual(environmentId(other), environmentId(base), field);
    assert.deepEqual(
      environmentDifferences(base, other).map((entry) => entry.field),
      [field],
    );
  }
});

test('compareImages counts changed pixels, groups them into regions and fails a size change', () => {
  const image = (
    width: number,
    height: number,
    paint?: (x: number, y: number) => boolean,
  ) => {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const dark = paint?.(x, y) ?? false;
        png.data[index] = dark ? 0 : 255;
        png.data[index + 1] = dark ? 0 : 255;
        png.data[index + 2] = dark ? 0 : 255;
        png.data[index + 3] = 255;
      }
    return PNG.sync.write(png);
  };
  const blank = image(200, 100);
  const same = compareImages(blank, image(200, 100), tolerance);
  assert.equal(same.pixels.diff, 0);
  assert.equal(same.mismatch, false);
  assert.equal(same.regionCount, 0);
  // Two separate 10x10 blocks: two regions, 200 pixels.
  const two = compareImages(
    blank,
    image(
      200,
      100,
      (x, y) =>
        (x >= 10 && x < 20 && y >= 10 && y < 20) ||
        (x >= 150 && x < 160 && y >= 60 && y < 70),
    ),
    tolerance,
  );
  assert.equal(two.pixels.diff, 200);
  assert.equal(two.regionCount, 2);
  assert.equal(two.mismatch, true);
  assert.deepEqual(
    two.regions.map((region) => region.diffPixels),
    [100, 100],
  );
  for (const region of two.regions) {
    assert.ok(region.width >= 10 && region.width <= 32);
    assert.ok(region.height >= 10 && region.height <= 32);
  }
  // Within an explicit tolerance it matches.
  assert.equal(
    compareImages(
      blank,
      image(200, 100, (x, y) => x === 5 && y === 5),
      {
        ...tolerance,
        maxDiffPixels: 1,
        maxDiffRatio: 0.001,
      },
    ).mismatch,
    false,
  );
  // Pixels inside a masked box are not compared; outside it they are.
  const inBox = (x: number, y: number) =>
    x >= 40 && x < 60 && y >= 40 && y < 60;
  const maskedOnly = compareImages(blank, image(200, 100, inBox), tolerance, [
    { x: 40, y: 40, width: 20, height: 20 },
  ]);
  assert.equal(maskedOnly.pixels.diff, 0);
  assert.equal(maskedOnly.pixels.total, 200 * 100 - 400);
  assert.equal(maskedOnly.mismatch, false);
  const outside = compareImages(
    blank,
    image(200, 100, (x, y) => inBox(x, y) || (x === 100 && y === 50)),
    tolerance,
    [{ x: 40, y: 40, width: 20, height: 20 }],
  );
  assert.equal(outside.pixels.diff, 1);
  assert.equal(outside.mismatch, true);
  const resized = compareImages(blank, image(200, 120), tolerance);
  assert.equal(resized.pixels.sizeChanged, true);
  assert.equal(resized.mismatch, true);
  assert.equal(resized.pixels.diff, 200 * 20);
});

// Calibration: repeated captures of stable pages stay within the default
// tolerance (in practice identical), and the smallest seeded meaningful
// change exceeds it. The numbers are printed as test diagnostics.
test('calibration: repeated stable captures stay in tolerance; seeded changes fail', async (t) => {
  const fixtures: [string, string][] = [
    ['article', article()],
    [
      'article with focused field and animations',
      article({ clock: '09:41:00' }),
    ],
    ['done', done()],
  ];
  for (const [name, html] of fixtures) {
    const first = await capture(html);
    assert.ok(first.png, `${name} settles`);
    let worst = 0;
    const captures = [first.captures];
    for (let repeat = 0; repeat < 4; repeat++) {
      const again = await capture(html);
      assert.ok(again.png, `${name} settles on repeat ${repeat + 1}`);
      captures.push(again.captures);
      const compared = compareImages(first.png, again.png, tolerance);
      worst = Math.max(worst, compared.pixels.diff);
      assert.equal(
        compared.mismatch,
        false,
        `${name} repeat ${repeat + 1} matches`,
      );
    }
    t.diagnostic(
      `calibration ${name}: worst repeat diff ${worst} px over 5 fresh captures; captures to settle ${captures.join(',')}`,
    );
  }
  const baseline = await pngOf(article());
  const seeded: [string, ArticleVariant][] = [
    ['one word', { button: 'Save change' }],
    ['2px move', { shift: 2 }],
    ['accent colour', { accent: '#2a7d9d' }],
  ];
  for (const [name, variant] of seeded) {
    const compared = compareImages(
      baseline,
      await pngOf(article(variant)),
      tolerance,
    );
    t.diagnostic(
      `calibration seeded ${name}: ${compared.pixels.diff} px (${(compared.pixels.ratio * 100).toFixed(4)}%) in ${compared.regionCount} region(s)`,
    );
    assert.equal(compared.mismatch, true, `${name} fails`);
    assert.ok(
      compared.pixels.diff > 20,
      `${name} is far over the 0 px allowance`,
    );
  }
});

test('an always-changing page is unstable, and masking the changing region settles it', async () => {
  const unstable = await capture(ticker());
  assert.equal(unstable.png, null);
  assert.equal(unstable.captures, 5);
  const masked = await capture(ticker(), { mask: ['#count'] });
  assert.ok(masked.png);
});

test('masks hide only what they cover: a masked clock never differs, an unmasked change still fails', async () => {
  const mask = ['#clock'];
  const baseline = await pngOf(article({ clock: '08:00:00' }), { mask });
  const clockOnly = compareImages(
    baseline,
    await pngOf(article({ clock: '23:59:59' }), { mask }),
    tolerance,
  );
  assert.equal(clockOnly.pixels.diff, 0);
  assert.equal(clockOnly.mismatch, false);
  // Without the mask the clock change is a mismatch.
  assert.equal(
    compareImages(
      await pngOf(article({ clock: '08:00:00' })),
      await pngOf(article({ clock: '23:59:59' })),
      tolerance,
    ).mismatch,
    true,
  );
  const unmaskedChange = compareImages(
    baseline,
    await pngOf(article({ clock: '23:59:59', button: 'Save change' }), {
      mask,
    }),
    tolerance,
  );
  assert.equal(unmaskedChange.mismatch, true);
  assert.ok(unmaskedChange.regionCount >= 1);
  // The changed region is the button, not the masked footer.
  const footerTop = 400;
  assert.ok(unmaskedChange.regions.every((region) => region.y < footerTop));
});

// The run's evidence protection (2B) is applied to every visual capture, so a
// secret never reaches a baseline or a comparison image.
test('a planted secret is masked in baseline and current, and the masked area does not differ', async () => {
  const protection: ScreenshotProtection = {
    masks: [],
    patterns: [{ label: 'token', source: 'sk-live-[A-Za-z0-9]+', flags: '' }],
    maskColor: MASK_COLOR,
  };
  const first = article({ token: 'sk-live-AAAA1111' });
  const second = article({ token: 'sk-live-ZZZZ9999' });
  const box = async (html: string) => {
    const context = await browser.newContext({
      viewport: { width: 900, height: 700 },
    });
    try {
      const page = await context.newPage();
      await page.setContent(html);
      return (await page.locator('#token').boundingBox())!;
    } finally {
      await context.close();
    }
  };
  const tokenBox = await box(first);
  const magenta = (png: Buffer) => {
    const image = PNG.sync.read(png);
    let painted = 0;
    let total = 0;
    for (
      let y = Math.ceil(tokenBox.y);
      y < Math.floor(tokenBox.y + tokenBox.height);
      y++
    )
      for (
        let x = Math.ceil(tokenBox.x);
        x < Math.floor(tokenBox.x + tokenBox.width);
        x++
      ) {
        const index = (y * image.width + x) * 4;
        total++;
        if (
          image.data[index] === 255 &&
          image.data[index + 1] === 0 &&
          image.data[index + 2] === 255
        )
          painted++;
      }
    return { painted, total };
  };
  const baseline = await pngOf(first, { protection });
  const current = await pngOf(second, { protection });
  for (const png of [baseline, current]) {
    const { painted, total } = magenta(png);
    assert.ok(total > 50);
    assert.equal(painted, total, 'every pixel of the token is the mask colour');
  }
  assert.equal(compareImages(baseline, current, tolerance).pixels.diff, 0);
  // Unprotected, the two tokens render differently: the mask is what hides it.
  const plain = compareImages(
    await pngOf(first),
    await pngOf(second),
    tolerance,
  );
  assert.ok(plain.pixels.diff > 0);
  assert.equal(magenta(await pngOf(first)).painted, 0);
  // protectedScreenshot is the capture path: the same page, same protection.
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 },
  });
  try {
    const page: Page = await context.newPage();
    await page.setContent(first);
    const direct = await protectedScreenshot(page, protection, {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
    assert.equal(magenta(direct).painted, magenta(direct).total);
  } finally {
    await context.close();
  }
});

test('the Playwright audit reports missing without a baseline directory and writes the capture into the run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-visual-direct-'));
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(article());
    const output = auditOutputSchema.parse(
      await visualBaselinePlaywrightAudit(
        page,
        {
          config: auditConfigSchema.parse({
            id: 'visual.baseline',
            mask: ['#clock', '#absent'],
          }),
          checkpoint: {
            id: 'ready',
            kind: 'ready',
            name: null,
            step: 0,
            url: null,
            screenshot: null,
          },
          viewport: { name: 'desktop', width: 900, height: 700 },
          directory,
          scope: { suite: 'Visual fixture', journey: 'billing' },
          baselines: null,
          timeoutMs: 20000,
        },
        { browser: 'chromium', build: 'bundled', headless: true },
        undefined,
      ),
    );
    assert.equal(output.complete, false);
    assert.equal(output.findings.length, 0);
    assert.equal(output.visual?.status, 'missing');
    assert.match(output.detail ?? '', /no baseline directory/);
    assert.ok(output.visual?.current && existsSync(output.visual.current.file));
    assert.equal(output.visual?.environment.browser.name, 'chromium');
    assert.equal(output.visual?.environment.deviceScaleFactor, 1);
    assert.deepEqual(output.visual?.masks, [
      { selector: '#clock', matched: 1 },
      { selector: '#absent', matched: 0 },
    ]);
    assert.ok(output.limitations.some((line) => line.includes('#absent')));
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Real journeys: ready on "/", completion on "/done".

const journey: Journey = {
  id: 'billing',
  goal: 'Continue to the saved page',
  persona: 'A returning customer',
  startPath: '/',
  allowedPaths: ['/', '/done'],
  ready: { kind: 'path', pattern: '^/$' },
  success: [{ kind: 'path', pattern: '^/done$' }],
  interactions: [],
  discoverRoles: [],
  maxSteps: 4,
  maxDurationMs: 60000,
};

const selected = (choice: string, actions: Action[]): Choice => ({
  type: 'choice',
  choice,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
    ['no_match', choice === 'no_match' ? 1 : 0],
  ]),
});
const deterministic: Models = {
  async plan() {
    return { objective: 'Open the Continue link', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return selected(
      actions.find(
        (action) =>
          action.kind === 'link' && action.description.includes('Continue'),
      )?.id ?? 'no_match',
      actions,
    );
  },
};

async function journeyRun(
  url: string,
  baselines: string | undefined,
  width = 1280,
  evidence?: unknown,
): Promise<{ result: Result; directory: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'ui-ux-visual-run-'));
  const directory = join(parent, 'run');
  const suite = suiteSchema.parse({
    name: 'LOCAL fixture — visual baselines',
    baseURL: url,
    requiresAuth: false,
    viewports: [{ name: 'desktop', width, height: 800 }],
    ...(evidence === undefined ? {} : { evidence }),
    journeys: [journey],
    audits: {
      checks: [
        {
          id: 'visual.baseline',
          at: ['ready', 'completion'],
          mask: ['#clock'],
        },
      ],
    },
  });
  const [result] = await runSuite(suite, deterministic, {
    directory,
    baselines,
    env: {},
  });
  assert.ok(result);
  assert.equal(result.status, 'passed', result.reason);
  return { result, directory };
}

const visualRuns = (result: Result) =>
  result.audits.runs.filter((run) => run.auditId === 'visual.baseline');
const statuses = (result: Result) =>
  visualRuns(result).map((run) => [run.checkpoint.id, run.visual?.status]);
const visualCheck = (result: Result) =>
  result.quality.executed.find((check) => check.id === 'visual.baseline');

test('a journey captures, never approves on its own, then matches, mismatches and updates only on explicit approval', async () => {
  const app = await site();
  const baselines = await mkdtemp(join(tmpdir(), 'ui-ux-visual-baselines-'));
  try {
    let clock = 0;
    app.state.done = () => done(`10:00:${String(clock++).padStart(2, '0')}`);

    // 1. Nothing approved: missing at both checkpoints, never a pass, and the
    // baseline directory stays empty.
    const first = await journeyRun(app.url, baselines);
    assert.deepEqual(statuses(first.result), [
      ['ready', 'missing'],
      ['completion', 'missing'],
    ]);
    assert.equal(visualCheck(first.result)?.status, 'inconclusive');
    assert.equal(first.result.quality.verdict, 'not_evaluated');
    assert.ok(
      !first.result.quality.unsupported.some(
        (gap) => gap.id === 'visual.baseline',
      ),
      'a configured comparison is not listed as not implemented',
    );
    assert.deepEqual(await readdir(baselines), []);
    for (const run of visualRuns(first.result))
      assert.ok(run.visual?.current && existsSync(run.visual.current.file));
    const firstReport = await readFile(
      join(first.directory, 'report.html'),
      'utf8',
    );
    assert.match(firstReport, /NO APPROVED BASELINE \(not a pass\)/);
    assert.match(firstReport, /visual-ready-current\.png/);

    // Approval is explicit: no selection is refused.
    await assert.rejects(
      approveBaselines({ run: first.directory, baselines }),
      /--all/,
    );
    const approved = await approveBaselines({
      run: first.directory,
      baselines,
      all: true,
    });
    assert.deepEqual(
      approved.map((entry) => [entry.key.checkpoint, entry.action]),
      [
        ['ready', 'created'],
        ['completion', 'created'],
      ],
    );
    assert.equal((await listBaselines(baselines)).length, 2);

    // 2. Unchanged UI (the masked clock still ticks): match, quality pass.
    const second = await journeyRun(app.url, baselines);
    assert.deepEqual(statuses(second.result), [
      ['ready', 'match'],
      ['completion', 'match'],
    ]);
    assert.equal(visualCheck(second.result)?.status, 'passed');
    assert.equal(second.result.quality.verdict, 'pass');
    for (const run of visualRuns(second.result)) {
      assert.equal(run.status, 'clean');
      assert.equal(run.visual?.pixels?.diff, 0);
      assert.ok(run.visual?.baseline && existsSync(run.visual.baseline.file));
      assert.ok(run.visual?.diff && existsSync(run.visual.diff));
    }

    // 3. A seeded change on "/": a gating mismatch with regions and images.
    app.state.start = () => article({ button: 'Save change' });
    const third = await journeyRun(app.url, baselines);
    assert.deepEqual(statuses(third.result), [
      ['ready', 'mismatch'],
      ['completion', 'match'],
    ]);
    const mismatch = third.result.audits.findings.find(
      (finding) => finding.ruleId === 'visual.mismatch',
    );
    assert.ok(mismatch);
    assert.equal(mismatch.gating, true);
    assert.equal(mismatch.reproduction.checkpoint, 'ready');
    assert.equal(mismatch.evidence.files.length, 3);
    assert.equal(visualCheck(third.result)?.status, 'failed');
    assert.equal(third.result.quality.verdict, 'fail');
    const ready = visualRuns(third.result)[0]!.visual!;
    assert.ok(ready.pixels && ready.pixels.diff > 0);
    assert.ok(ready.regionCount >= 1);
    const report = await readFile(join(third.directory, 'report.html'), 'utf8');
    assert.match(report, /MISMATCH/);
    for (const name of ['baseline', 'current', 'diff'])
      assert.match(
        report,
        new RegExp(`<img src="[^"]*visual-ready-${name}\\.png"`),
      );
    assert.match(report, /<details open>/);

    // Updating needs --replace; without it the mismatch is skipped.
    const refused = await approveBaselines({
      run: third.directory,
      baselines,
      checkpoint: 'ready',
    });
    assert.deepEqual(
      refused.map((entry) => entry.action),
      ['skipped'],
    );
    assert.match(refused[0]!.reason, /--replace/);
    const replaced = await approveBaselines({
      run: third.directory,
      baselines,
      checkpoint: 'ready',
      replace: true,
    });
    assert.deepEqual(
      replaced.map((entry) => entry.action),
      ['replaced'],
    );
    const fourth = await journeyRun(app.url, baselines);
    assert.deepEqual(statuses(fourth.result), [
      ['ready', 'match'],
      ['completion', 'match'],
    ]);

    // 4. Another rendering environment (the viewport resized under the same
    // name): incompatible, named field, not compared and not a pass.
    const fifth = await journeyRun(app.url, baselines, 1200);
    assert.deepEqual(statuses(fifth.result), [
      ['ready', 'incompatible'],
      ['completion', 'incompatible'],
    ]);
    const incompatible = visualRuns(fifth.result)[0]!.visual!;
    assert.deepEqual(
      incompatible.incompatible.map((entry) => entry.field),
      ['viewport.width'],
    );
    assert.equal(incompatible.pixels, null);
    assert.equal(fifth.result.quality.verdict, 'not_evaluated');
    assert.match(
      await readFile(join(fifth.directory, 'report.html'), 'utf8'),
      /INCOMPATIBLE BASELINE[\s\S]*viewport\.width/,
    );

    // A capture changed after the run is never approved.
    const tampered = visualRuns(fifth.result)[0]!.visual!.current!.file;
    await writeFile(
      tampered,
      await readFile(visualRuns(fifth.result)[1]!.visual!.current!.file),
    );
    const decisions = await approveBaselines({
      run: fifth.directory,
      baselines,
      checkpoint: 'ready',
    });
    assert.equal(decisions[0]!.action, 'skipped');
    assert.match(decisions[0]!.reason, /changed after the run/);
  } finally {
    await app.close();
  }
});

test("a journey's visual captures go through the suite's evidence protection: a planted secret and a configured mask are magenta in the capture and the baseline", async () => {
  const app = await site();
  const baselines = await mkdtemp(join(tmpdir(), 'ui-ux-visual-baselines-'));
  const secret = 'sk-live-PLANTED4242';
  const evidence = {
    redact: [{ pattern: 'sk-live-[A-Za-z0-9]+', label: 'token' }],
    masks: [{ by: 'css', value: 'h1' }],
  };
  try {
    app.state.start = () => article({ token: secret });
    // Where the token and the heading render at the run's viewport.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    let boxes: { x: number; y: number; width: number; height: number }[];
    try {
      const page = await context.newPage();
      await page.setContent(article({ token: secret }));
      boxes = [
        (await page.locator('#token').boundingBox())!,
        (await page.locator('h1').boundingBox())!,
      ];
    } finally {
      await context.close();
    }
    const painted = (png: Buffer) =>
      boxes.map((box) => {
        const image = PNG.sync.read(png);
        let magenta = 0;
        let total = 0;
        for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++)
          for (
            let x = Math.ceil(box.x);
            x < Math.floor(box.x + box.width);
            x++
          ) {
            const index = (y * image.width + x) * 4;
            total++;
            if (
              image.data[index] === 255 &&
              image.data[index + 1] === 0 &&
              image.data[index + 2] === 255
            )
              magenta++;
          }
        assert.ok(total > 50);
        return magenta / total;
      });

    const first = await journeyRun(app.url, baselines, 1280, evidence);
    const ready = visualRuns(first.result)[0]!.visual!;
    assert.equal(ready.key.checkpoint, 'ready');
    assert.equal(ready.status, 'missing');
    assert.equal(ready.environment.capture.protected, true);
    const current = await readFile(ready.current!.file);
    assert.deepEqual(painted(current), [1, 1], 'token and heading are masked');
    // The sweep leaves the capture byte-for-byte as recorded.
    assert.equal(
      createHash('sha256').update(current).digest('hex'),
      ready.current!.sha256,
    );
    // No text evidence of the run (results, comparison records, the report,
    // the event log) holds the secret.
    const texts: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (!path.endsWith('.png')) texts.push(path);
      }
    };
    await walk(first.directory);
    assert.ok(texts.some((path) => path.endsWith('results.json')));
    for (const path of texts)
      assert.ok(
        !(await readFile(path, 'utf8')).includes(secret),
        `${path} holds the planted secret`,
      );

    // Approval copies the masked capture; the baseline and its metadata never
    // hold the secret either.
    await approveBaselines({ run: first.directory, baselines, all: true });
    const [baseline] = (await listBaselines(baselines)).filter(
      (entry) => entry.key.checkpoint === 'ready',
    );
    assert.ok(baseline);
    assert.equal(baseline.environment.capture.protected, true);
    assert.deepEqual(painted(await readFile(baseline.file)), [1, 1]);
    const metadata = await readFile(
      baseline.file.replace(/\.png$/, '.json'),
      'utf8',
    );
    assert.ok(!metadata.includes(secret));

    // Another secret under the mask is not a visual change.
    app.state.start = () => article({ token: 'sk-live-ROTATED9999' });
    const second = await journeyRun(app.url, baselines, 1280, evidence);
    assert.deepEqual(statuses(second.result)[0], ['ready', 'match']);
  } finally {
    await app.close();
  }
});

test('--prune-runs deletes an expired run and never the baselines approved from it; baselines inside a run directory are refused', async () => {
  const app = await site();
  const root = await mkdtemp(join(tmpdir(), 'ui-ux-visual-prune-'));
  const baselines = join(root, '.baselines');
  await mkdir(baselines);
  try {
    const first = await journeyRun(app.url, baselines);
    await approveBaselines({ run: first.directory, baselines, all: true });
    // The run, manifest included, moved under a runs root next to the
    // baselines.
    const runs = join(root, 'runs');
    await mkdir(runs);
    const expired = join(runs, 'first');
    await rename(first.directory, expired);
    const approved = await listBaselines(baselines);
    assert.equal(approved.length, 2);
    const snapshot = async () =>
      Promise.all(
        approved.flatMap((entry) =>
          [entry.file, entry.file.replace(/\.png$/, '.json')].map((file) =>
            readFile(file),
          ),
        ),
      );
    const before = await snapshot();
    // Long after the run's retention: the run goes, the baselines stay, both
    // when pruning the runs root and when pointed at their common parent or
    // at the baseline directory itself.
    const later = new Date(Date.now() + 3650 * 86400000);
    for (const target of [root, baselines])
      for (const entry of await pruneRuns(target, { now: later }))
        assert.notEqual(entry.action, 'deleted', entry.directory);
    assert.deepEqual(
      (await pruneRuns(runs, { now: later })).map((entry) => entry.action),
      ['deleted'],
    );
    assert.ok(!existsSync(expired));
    assert.deepEqual(await snapshot(), before);
    const second = await journeyRun(app.url, baselines);
    assert.deepEqual(statuses(second.result), [
      ['ready', 'match'],
      ['completion', 'match'],
    ]);

    // A baseline directory under a run directory would be pruned with it.
    const nested = join(second.directory, 'baselines');
    await assert.rejects(
      approveBaselines({ run: second.directory, baselines: nested, all: true }),
      /inside the run directory/,
    );
    await mkdir(nested);
    await assert.rejects(
      baselineDirectoryForRun(nested),
      /inside the run directory/,
    );
  } finally {
    await app.close();
  }
});

test('approval finds captures whose recorded path the evidence redaction rewrote, and skips a redacted suite name', async () => {
  const app = await site();
  const baselines = await mkdtemp(join(tmpdir(), 'ui-ux-visual-baselines-'));
  try {
    // The run directory's parent name is a secret value of the run: every
    // path in results.json gets redacted.
    const parent = await mkdtemp(join(tmpdir(), 'ui-ux-visual-tag-'));
    const tag = basename(parent);
    const directory = join(parent, 'run');
    const suite = suiteSchema.parse({
      name: 'LOCAL fixture — visual baselines',
      baseURL: app.url,
      requiresAuth: false,
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      journeys: [journey],
      evidence: { redactEnv: ['UIUX_TEST_RUN_TAG'] },
      audits: {
        checks: [
          {
            id: 'visual.baseline',
            at: ['ready', 'completion'],
            mask: ['#clock'],
          },
        ],
      },
    });
    const [result] = await runSuite(suite, deterministic, {
      directory,
      baselines,
      env: { UIUX_TEST_RUN_TAG: tag },
    });
    assert.equal(result?.status, 'passed', result?.reason);
    const results = await readFile(join(directory, 'results.json'), 'utf8');
    assert.ok(!results.includes(tag));
    for (const run of visualRuns(result!))
      assert.match(
        run.visual!.current!.file,
        /\[REDACTED:env:UIUX_TEST_RUN_TAG\]/,
      );
    const approved = await approveBaselines({
      run: directory,
      baselines,
      all: true,
    });
    assert.deepEqual(
      approved.map((entry) => [entry.key.checkpoint, entry.action]),
      [
        ['ready', 'created'],
        ['completion', 'created'],
      ],
    );
    // The approved images are the run's captures, and the next run matches.
    for (const entry of await listBaselines(baselines))
      assert.equal(
        createHash('sha256')
          .update(await readFile(entry.file))
          .digest('hex'),
        entry.image.sha256,
      );
    const next = await journeyRun(app.url, baselines);
    assert.deepEqual(statuses(next.result), [
      ['ready', 'match'],
      ['completion', 'match'],
    ]);

    // A suite name rewritten by the suite's own pattern would file the
    // baseline under a key no run looks up: skipped, with the reason.
    const named = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-visual-run-')),
      'run',
    );
    const [redacted] = await runSuite(
      suiteSchema.parse({
        ...suite,
        name: 'LOCAL fixture ACME-CASE-123456',
        evidence: { redact: [{ pattern: 'ACME-CASE-\\d{6}' }] },
      }),
      deterministic,
      { directory: named, baselines, env: {} },
    );
    assert.equal(redacted?.status, 'passed', redacted?.reason);
    const skipped = await approveBaselines({
      run: named,
      baselines,
      all: true,
    });
    assert.equal(skipped.length, 2);
    for (const entry of skipped) {
      assert.equal(entry.action, 'skipped');
      assert.match(
        entry.reason,
        /suite name in this run's results was redacted/,
      );
    }
  } finally {
    await app.close();
  }
});

test('runs reject a missing baseline directory, and baselines stay out of Git', async () => {
  const app = await site();
  try {
    await assert.rejects(
      journeyRun(app.url, join(tmpdir(), 'ui-ux-visual-does-not-exist')),
      /does not exist/,
    );
  } finally {
    await app.close();
  }
  const repository = await mkdtemp(join(tmpdir(), 'ui-ux-visual-git-'));
  await git('git', ['init', '-q', repository]);
  const tracked = join(repository, 'baselines');
  await mkdir(tracked);
  await assert.rejects(assertOutsideGit(tracked), /not ignored by Git/);
  await writeFile(join(repository, '.gitignore'), 'baselines/\n');
  await assertOutsideGit(tracked);
});

test('the report shows an unstable capture and an empty comparison section without visual runs', async () => {
  const app = await site();
  try {
    app.state.start = () => ticker();
    const { result, directory } = await journeyRun(app.url, undefined);
    assert.deepEqual(statuses(result), [
      ['ready', 'unstable'],
      ['completion', 'missing'],
    ]);
    assert.equal(visualRuns(result)[0]!.status, 'incomplete');
    assert.equal(result.quality.verdict, 'not_evaluated');
    const html = reportHTML('visual', [result], directory);
    assert.match(html, /UNSTABLE CAPTURE/);
    const plain = reportHTML(
      'visual',
      [{ ...result, audits: { ...result.audits, runs: [] } }],
      directory,
    );
    assert.doesNotMatch(plain, /Visual comparisons/);
  } finally {
    await app.close();
  }
});
