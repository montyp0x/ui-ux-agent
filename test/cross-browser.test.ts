// The browser support matrix (README "Browser support") by real execution:
// every engine runs the same scripted journeys against the same local
// fixture, and every audit, evidence format and driver feature either works
// on it or reports `unsupported` with the engine's reason. An engine that is
// not installed or does not launch here is skipped (test/engines.ts), never
// counted as verified. No model calls: decisions are scripted.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AUDIT_IDS } from '../src/audits/config.js';
import { approveBaselines } from '../src/baselines.js';
import { candidates } from '../src/browser.js';
import {
  ENGINE_AUDIT_SUPPORT,
  ENGINE_EMULATION,
  ENGINE_GAPS,
  ENGINE_TYPED_OM,
  KEYBOARD_JOURNEY_UNSUPPORTED,
  ENGINE_PERFORMANCE_UNREPORTED,
  engineAuditGap,
  environmentEmulation,
} from '../src/browser-support.js';
import { auditConfigSchema } from '../src/audits/config.js';
import { auditOutputSchema } from '../src/audits/contract.js';
import {
  MAX_RUN_COMBINATIONS,
  pseudoLocalizationScript,
} from '../src/environments.js';
import { compatibility, findingInstances } from '../src/compare.js';
import { environmentId } from '../src/audits/visual.js';
import { suiteSchema, type Action, type Choice } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import type { Result } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { pixelCounts } from './evidence-fixtures.js';
import { ENGINES, ENGINE_TYPES, engineSkip, type Engine } from './engines.js';

const skips = Object.fromEntries(
  await Promise.all(
    ENGINES.map(async (engine) => [engine, await engineSkip(engine)] as const),
  ),
) as Record<Engine, string | false>;

// The start page carries one known defect per audit: an unlabelled input
// (axe), a block wider than every viewport (horizontal overflow and
// layout.responsive), and a planted red secret for screenshot masking.
const START = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cross-browser fixture</title><style>body{font:16px sans-serif;margin:24px}.wide{width:1600px;height:8px;background:#ccc}.secret{color:#ff0000;font:bold 48px sans-serif}</style></head><body><main><h1>Cross-browser fixture</h1><p><input type="text"></p><div class="wide"></div><p class="secret" data-testid="secret">TOKEN-1234</p><p><a href="/done">Continue</a></p></main></body></html>`;
const DONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title></head><body><main><h1>Done</h1><p data-testid="status">Saved</p></main></body></html>`;
const TAB_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tab</title></head><body><main><input aria-label="Name"><a href="#a">Docs</a><button>Save</button></main></body></html>`;

// The start page without its planted defects, for runs whose quality must
// be able to pass.
const CLEAN_START = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cross-browser fixture</title></head><body><main><h1>Cross-browser fixture</h1><p><a href="/done">Continue</a></p></main></body></html>`;

async function site(start = START) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/done' ? DONE : start);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const journey = {
  id: 'continue',
  goal: 'Continue to the confirmation',
  persona: 'A first-time visitor',
  startPath: '/',
  allowedPaths: ['/', '/done'],
  ready: {
    kind: 'visible',
    target: { by: 'role', role: 'heading', name: 'Cross-browser fixture' },
  },
  success: [{ kind: 'path', pattern: '^/done$' }],
  states: [
    {
      name: 'confirmation',
      when: {
        kind: 'visible',
        target: { by: 'role', role: 'heading', name: 'Done' },
      },
      // One expectation holds and one does not: the audit must evaluate both.
      expect: [
        {
          kind: 'text',
          target: { by: 'testId', value: 'status' },
          pattern: 'Saved',
        },
        {
          kind: 'visible',
          target: { by: 'testId', value: 'receipt' },
        },
      ],
    },
  ],
  maxSteps: 4,
  maxDurationMs: 60000,
};

// The same journey without declared states, for runs without audits (states
// need an audit that runs at them).
const { states: _states, ...plainJourney } = journey;

const AUDITS = {
  checks: [
    { id: 'accessibility.axe', at: ['ready'] },
    { id: 'layout.horizontal-overflow', at: ['ready'] },
    {
      id: 'layout.responsive',
      at: ['ready'],
      matrix: { breakpoints: [{ name: 'mobile', width: 390, height: 844 }] },
    },
    { id: 'visual.baseline', at: ['ready'], mask: ['.wide'] },
    { id: 'journey.state-checks' },
    { id: 'keyboard.focus' },
    // The fixture's #ccc block and red secret are off this scale.
    {
      id: 'design.tokens',
      at: ['ready'],
      include: ['main'],
      tokens: {
        version: 1,
        color: { ink: '#000000', paper: '#ffffff' },
        spacing: { s4: '24px' },
      },
    },
  ],
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

async function run(
  engine: Engine,
  url: string,
  suite: Record<string, unknown>,
  options: { baselines?: string; video?: boolean; profile?: string } = {},
): Promise<{ result: Result; directory: string }> {
  const parent = await mkdtemp(join(tmpdir(), `ui-ux-${engine}-`));
  const directory = join(parent, 'run');
  const [result] = await runSuite(
    suiteSchema.parse({
      name: 'LOCAL fixture — cross-browser support',
      baseURL: url,
      requiresAuth: false,
      browser: engine,
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      journeys: [suite.audits ? journey : plainJourney],
      ...suite,
    }),
    deterministic,
    { directory, env: {}, ...options },
  );
  assert.ok(result);
  assert.equal(result.status, 'passed', result.reason);
  return { result, directory };
}

async function pngs(directory: string): Promise<string[]> {
  const files = await readdir(directory, { recursive: true });
  return files
    .filter((file) => /(^|[\\/])(step-\d+|final)\.png$/.test(file))
    .map((file) => join(directory, file));
}

async function launchedVersion(engine: Engine): Promise<string> {
  const browser = await ENGINE_TYPES[engine].launch();
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

const auditStatus = (result: Result, id: string) =>
  result.audits.runs
    .filter((entry) => entry.auditId === id)
    .map((entry) => entry.status);

// Kept for the cross-engine comparison test.
const identities = new Map<Engine, NonNullable<Result['identity']>>();

test('every audit and engine has a declared verification state', () => {
  for (const engine of ENGINES)
    assert.deepEqual(
      Object.keys(ENGINE_AUDIT_SUPPORT[engine]).sort(),
      [...AUDIT_IDS].sort(),
      `${engine} declares every audit`,
    );
  // Chromium is the reference engine: everything is verified on it.
  assert.ok(
    Object.values(ENGINE_AUDIT_SUPPORT.chromium).every(
      (reason) => reason === null,
    ),
  );
  assert.deepEqual(ENGINE_GAPS.chromium, []);
  // Firefox is not verified anywhere yet: nothing on it is claimed.
  assert.ok(
    Object.values(ENGINE_AUDIT_SUPPORT.firefox).every(
      (reason) => typeof reason === 'string' && /not verified/i.test(reason),
    ),
  );
});

test('a keyboard-only journey is refused on WebKit, at suite validation', () => {
  const parsed = suiteSchema.safeParse({
    name: 'LOCAL keyboard on WebKit',
    baseURL: 'http://127.0.0.1:1',
    browser: 'webkit',
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [{ ...plainJourney, input: 'keyboard' }],
  });
  assert.equal(parsed.success, false);
  assert.match(String(parsed.error), /WebKit/);
  assert.equal(
    parsed.error?.issues.some(
      (issue) => issue.message === KEYBOARD_JOURNEY_UNSUPPORTED.webkit,
    ),
    true,
  );
  // The same journey on Chromium is a valid suite.
  assert.equal(
    suiteSchema.safeParse({
      name: 'LOCAL keyboard on Chromium',
      baseURL: 'http://127.0.0.1:1',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      journeys: [{ ...plainJourney, input: 'keyboard' }],
    }).success,
    true,
  );
});

test('an environment setting is emulated only where the engine applies it; elsewhere it is an unsupported gap with the engine reason', () => {
  const everything = {
    name: 'everything',
    locale: 'de-DE',
    timezone: 'Asia/Tokyo',
    colorScheme: 'dark' as const,
    reducedMotion: 'reduce' as const,
    forcedColors: 'active' as const,
    contrast: 'more' as const,
    pseudoLocalization: {},
  };
  // Chromium applies every setting: nothing is withheld.
  const chromium = environmentEmulation('chromium', everything);
  assert.deepEqual(chromium.unsupported, []);
  assert.deepEqual(chromium.environment, everything);
  // WebKit matches (forced-colors: active) without replacing author colours,
  // so forced colours are not emulated there and the run says so; the other
  // settings are applied.
  const webkit = environmentEmulation('webkit', everything);
  assert.deepEqual(
    webkit.unsupported.map((gap) => gap.id),
    ['environment.forcedColors'],
  );
  assert.match(webkit.unsupported[0]!.reason, /WebKit/);
  assert.match(webkit.unsupported[0]!.reason, /author colours are not replaced/);
  const { forcedColors: _forced, ...withoutForced } = everything;
  assert.deepEqual(webkit.environment, withoutForced);
  // Forced colours off is what WebKit renders anyway: applied.
  assert.deepEqual(
    environmentEmulation('webkit', { name: 'plain', forcedColors: 'none' })
      .unsupported,
    [],
  );
  // Nothing was executed on Firefox: every requested setting is unsupported.
  const firefox = environmentEmulation('firefox', everything);
  assert.deepEqual(
    firefox.unsupported.map((gap) => gap.id),
    [
      'environment.locale',
      'environment.timezone',
      'environment.colorScheme',
      'environment.reducedMotion',
      'environment.forcedColors',
      'environment.contrast',
      'environment.pseudoLocalization',
    ],
  );
  for (const gap of firefox.unsupported) assert.match(gap.reason, /Firefox/);
  assert.deepEqual(firefox.environment, { name: 'everything' });
  // Settings an environment leaves out are never gaps.
  assert.deepEqual(
    environmentEmulation('firefox', { name: 'default' }).unsupported,
    [],
  );
});

test('performance.web is declared per engine: throttling needs Chromium, unreported metrics are listed, Firefox is unsupported', () => {
  const plain = auditConfigSchema.parse({ id: 'performance.web' });
  const throttled = auditConfigSchema.parse({
    id: 'performance.web',
    conditions: { cpuSlowdown: 4 },
  });
  assert.equal(engineAuditGap('chromium', plain), null);
  assert.equal(engineAuditGap('chromium', throttled), null);
  assert.equal(engineAuditGap('webkit', plain), null);
  // Conditions are applied through Chromium's DevTools protocol: a throttled
  // run on another engine is unsupported, never measured unthrottled.
  assert.match(engineAuditGap('webkit', throttled) ?? '', /Chromium's DevTools protocol/);
  assert.match(engineAuditGap('firefox', plain) ?? '', /Firefox/);
  // The metrics each engine does not report, as executed (Firefox: never
  // run, so nothing is declared).
  assert.deepEqual(ENGINE_PERFORMANCE_UNREPORTED.chromium, []);
  assert.ok(ENGINE_PERFORMANCE_UNREPORTED.webkit?.includes('cls'));
  assert.ok(ENGINE_PERFORMANCE_UNREPORTED.webkit?.includes('blockingTimeMs'));
  assert.equal(ENGINE_PERFORMANCE_UNREPORTED.firefox, null);
  // One mechanism: an audit's own output cannot declare itself unsupported.
  assert.equal(
    auditOutputSchema.safeParse({
      complete: false,
      findings: [],
      unsupported: 'not in this session',
    }).success,
    false,
  );
});

for (const engine of ENGINES) {
  const skip = skips[engine];
  const supported = (id: string) =>
    ENGINE_AUDIT_SUPPORT[engine][id as keyof (typeof ENGINE_AUDIT_SUPPORT)[Engine]] === null;

  test(`${engine}: every audit runs on the engine or reports unsupported with the engine's reason; screenshots are masked; visual baselines match`, { skip }, async () => {
    const app = await site();
    const baselines = await mkdtemp(join(tmpdir(), `ui-ux-${engine}-baselines-`));
    try {
      const evidence = { masks: [{ by: 'testId', value: 'secret' }] };
      const first = await run(
        engine,
        app.url,
        { audits: AUDITS, evidence },
        { baselines },
      );
      for (const id of AUDIT_IDS) {
        const configured = AUDITS.checks.some((check) => check.id === id);
        if (!configured) continue;
        const statuses = auditStatus(first.result, id);
        assert.ok(statuses.length, `${engine}: ${id} recorded a run`);
        if (supported(id))
          assert.ok(
            statuses.every(
              (status) => status !== 'unsupported' && status !== 'error',
            ),
            `${engine}: ${id} ran (${statuses.join(', ')})`,
          );
        else {
          assert.deepEqual(
            [...new Set(statuses)],
            ['unsupported'],
            `${engine}: ${id} is unsupported`,
          );
          for (const entry of first.result.audits.runs.filter(
            (entry) => entry.auditId === id,
          ))
            assert.equal(entry.detail, ENGINE_AUDIT_SUPPORT[engine][id]);
          assert.ok(
            first.result.quality.unsupported.some(
              (gap) =>
                gap.id === id && gap.reason === ENGINE_AUDIT_SUPPORT[engine][id],
            ),
            `${engine}: ${id} is listed as unsupported in the quality verdict`,
          );
        }
      }
      // The engine's known defects were really detected where supported.
      const ruleIds = (id: string) =>
        first.result.audits.findings
          .filter((finding) => finding.auditId === id)
          .map((finding) => finding.ruleId);
      if (supported('accessibility.axe'))
        assert.ok(ruleIds('accessibility.axe').includes('label'));
      if (supported('layout.horizontal-overflow'))
        assert.ok(
          ruleIds('layout.horizontal-overflow').includes(
            'document-wider-than-viewport',
          ),
        );
      if (supported('layout.responsive'))
        assert.ok(ruleIds('layout.responsive').length > 0);
      if (supported('journey.state-checks'))
        assert.deepEqual(ruleIds('journey.state-checks'), ['state-expectation']);
      if (supported('design.tokens')) {
        // Measured completely (Typed OM lengths read on this engine), and
        // the off-scale colours found.
        assert.deepEqual(auditStatus(first.result, 'design.tokens'), ['findings']);
        assert.ok(ruleIds('design.tokens').includes('color'));
      }
      // Engine-wide gaps are listed on the result.
      for (const gap of ENGINE_GAPS[engine])
        assert.ok(
          first.result.quality.unsupported.some(
            (entry) => entry.id === gap.id && entry.reason === gap.reason,
          ),
          `${engine}: ${gap.id} is listed`,
        );
      // Screenshot masking: the planted red secret never reaches an image.
      const shots = await pngs(first.directory);
      assert.ok(shots.length >= 2);
      const browser = await ENGINE_TYPES[engine].launch();
      try {
        const decoder = await browser.newPage();
        for (const shot of shots) {
          const counts = await pixelCounts(decoder, await readFile(shot));
          assert.equal(counts.red, 0, `${engine}: ${shot} shows the secret`);
          if (shot.endsWith('step-000.png'))
            assert.ok(counts.mask > 0, `${engine}: ${shot} carries the mask`);
        }
      } finally {
        await browser.close();
      }
      // Visual baselines: missing, explicit approval, then a match on the
      // same engine.
      if (supported('visual.baseline')) {
        first.result.audits.runs
          .filter((entry) => entry.auditId === 'visual.baseline')
          .forEach((entry) => assert.equal(entry.visual?.status, 'missing'));
        await approveBaselines({ run: first.directory, baselines, all: true });
        const second = await run(
          engine,
          app.url,
          { audits: AUDITS, evidence },
          { baselines },
        );
        const visual = second.result.audits.runs.filter(
          (entry) => entry.auditId === 'visual.baseline',
        );
        assert.deepEqual(
          visual.map((entry) => [entry.status, entry.visual?.status]),
          [['clean', 'match']],
        );
        assert.equal(
          visual[0]!.visual?.environment.browser.name,
          engine,
          'the baseline is keyed by the engine',
        );
      }
    } finally {
      await app.close();
    }
  });

  test(`${engine}: a journey records its trace and video, and its run identity names the engine and its version`, { skip }, async () => {
    const app = await site();
    try {
      const { result } = await run(engine, app.url, {}, { video: true });
      assert.ok(result.trace && existsSync(result.trace), `${engine}: trace`);
      assert.ok(result.video && existsSync(result.video), `${engine}: video`);
      const browser = result.identity?.environment.browser;
      assert.equal(browser?.name, engine);
      assert.equal(browser?.build, 'bundled');
      assert.equal(browser?.version, await launchedVersion(engine));
      identities.set(engine, result.identity!);
    } finally {
      await app.close();
    }
  });

  test(`${engine}: a dedicated persistent profile runs and reports the same browser version`, { skip }, async () => {
    const app = await site();
    try {
      const profile = join(
        await mkdtemp(join(tmpdir(), `ui-ux-${engine}-profile-`)),
        'profile',
      );
      const { result } = await run(engine, app.url, {}, { profile });
      assert.equal(result.identity?.environment.browser?.name, engine);
      assert.equal(
        result.identity?.environment.browser?.version,
        await launchedVersion(engine),
      );
    } finally {
      await app.close();
    }
  });

  test(`${engine}: the back action is offered exactly where the engine exposes session history, in launched browsers and persistent profiles`, { skip }, async () => {
    const app = await site();
    const backOffered = !ENGINE_GAPS[engine].some(
      (gap) => gap.id === 'navigation.back',
    );
    const offered = async (page: import('playwright').Page) => {
      await page.goto(`${app.url}/`);
      await page.goto(`${app.url}/done`);
      const actions = await candidates(
        page,
        suiteSchema.parse({
          name: 'LOCAL back',
          baseURL: app.url,
          viewports: [{ name: 'desktop', width: 1280, height: 800 }],
          journeys: [plainJourney],
        }).journeys[0]!,
        app.url,
      );
      return actions.some((action) => action.kind === 'back');
    };
    try {
      const browser = await ENGINE_TYPES[engine].launch();
      try {
        assert.equal(await offered(await browser.newPage()), backOffered);
      } finally {
        await browser.close();
      }
      const context = await ENGINE_TYPES[engine].launchPersistentContext(
        await mkdtemp(join(tmpdir(), `ui-ux-${engine}-back-profile-`)),
      );
      try {
        assert.equal(
          await offered(context.pages()[0] ?? (await context.newPage())),
          backOffered,
          `${engine}: persistent profile`,
        );
      } finally {
        await context.close();
      }
    } finally {
      await app.close();
    }
  });

  // Pins the behaviour behind KEYBOARD_JOURNEY_UNSUPPORTED: if the engine
  // starts (or stops) moving Tab focus through links and buttons, this fails
  // and the support table must be revisited.
  test(`${engine}: Tab moves focus through links and buttons exactly where keyboard-only journeys are supported`, { skip }, async () => {
    const browser = await ENGINE_TYPES[engine].launch();
    try {
      const page = await browser.newPage();
      await page.setContent(TAB_PAGE);
      const reached: string[] = [];
      for (let index = 0; index < 3; index++) {
        await page.keyboard.press('Tab');
        reached.push(
          await page.evaluate(
            () =>
              `${document.activeElement?.tagName.toLowerCase()}:${document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label')}`,
          ),
        );
      }
      const everyControl = ['input:Name', 'a:Docs', 'button:Save'];
      if (KEYBOARD_JOURNEY_UNSUPPORTED[engine])
        assert.notDeepEqual(reached, everyControl);
      else assert.deepEqual(reached, everyControl);
    } finally {
      await browser.close();
    }
  });

  test(`${engine}: emulated user settings are read back and rendered as the support table says`, { skip }, async () => {
    const browser = await ENGINE_TYPES[engine].launch();
    try {
      const read = async (
        options: Parameters<typeof browser.newContext>[0],
        pseudo = false,
      ) => {
        const context = await browser.newContext(options);
        try {
          if (pseudo)
            await context.addInitScript({
              content: pseudoLocalizationScript({}),
            });
          const page = await context.newPage();
          await page.setContent(
            '<p id="x" style="color:rgb(255,0,0);background:rgb(0,0,255)">x</p>',
          );
          return await page.evaluate(() => {
            const style = getComputedStyle(document.getElementById('x')!);
            return {
              colorScheme: matchMedia('(prefers-color-scheme: dark)').matches,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)')
                .matches,
              forcedColors: matchMedia('(forced-colors: active)').matches,
              contrast: matchMedia('(prefers-contrast: more)').matches,
              locale:
                navigator.language === 'de-DE' &&
                Intl.DateTimeFormat().resolvedOptions().locale === 'de-DE',
              timezoneId:
                Intl.DateTimeFormat().resolvedOptions().timeZone ===
                  'Asia/Tokyo' &&
                new Date('2026-01-01T00:00:00Z').getTimezoneOffset() === -540,
              // Forced colours replace author colours when rendered.
              forcedRendered: style.color !== 'rgb(255, 0, 0)',
              // The harness's padding was appended to the page text.
              pseudoLocalization: /^x ⟦[^⟧]+⟧$/.test(
                document.getElementById('x')!.textContent ?? '',
              ),
            };
          });
        } finally {
          await context.close();
        }
      };
      const emulated = await read({
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        forcedColors: 'active',
        contrast: 'more',
        locale: 'de-DE',
        timezoneId: 'Asia/Tokyo',
      }, true);
      const plain = await read({
        colorScheme: 'light',
        reducedMotion: 'no-preference',
        forcedColors: 'none',
        contrast: 'no-preference',
      });
      for (const [setting, support] of Object.entries(
        ENGINE_EMULATION[engine],
      ) as [keyof typeof emulated, string][]) {
        assert.notEqual(support, 'untested', `${engine} ran ${setting}`);
        assert.equal(emulated[setting], true, `${engine}: ${setting} reads back`);
        if (setting !== 'locale' && setting !== 'timezoneId')
          assert.equal(plain[setting], false, `${engine}: ${setting} off`);
      }
      assert.equal(plain.forcedRendered, false);
      assert.equal(
        emulated.forcedRendered,
        ENGINE_EMULATION[engine].forcedColors === 'applied',
        `${engine}: forced colours rendered`,
      );
    } finally {
      await browser.close();
    }
  });

  test(`${engine}: an environment runs with exactly the settings the engine applies; the rest are unsupported, never a pass or a driver error`, { skip }, async () => {
    const app = await site(CLEAN_START);
    try {
      const environment = {
        name: 'forced-dark',
        colorScheme: 'dark' as const,
        forcedColors: 'active' as const,
      };
      const { result, directory } = await run(engine, app.url, {
        environments: [environment],
        combinations: [{ environment: 'forced-dark', viewport: 'desktop' }],
      });
      const expected = environmentEmulation(engine, environment).unsupported;
      assert.equal(result.outcome.code, 'assertions_passed');
      assert.deepEqual(result.environment?.unsupported ?? [], expected);
      const gaps = result.quality.unsupported.filter((gap) =>
        gap.id.startsWith('environment.'),
      );
      assert.deepEqual(gaps, expected);
      const applied = (
        await readFile(join(directory, 'events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string; data: any })
        .find((entry) => entry.event === 'environment_applied');
      assert.ok(applied);
      assert.deepEqual(applied.data.unsupported, expected);
      assert.equal(applied.data.measured.colorScheme, 'dark');
      if (expected.length) {
        // Withheld, not half-applied: the page never sees the media query,
        // and the run cannot pass quality for an environment it did not
        // emulate.
        assert.equal(applied.data.measured.forcedColors, 'none');
        assert.notEqual(result.quality.verdict, 'pass');
        assert.match(result.quality.reason, /environment/i);
      } else {
        assert.equal(applied.data.measured.forcedColors, 'active');
        assert.equal(result.quality.verdict, 'pass', result.quality.reason);
      }
    } finally {
      await app.close();
    }
  });

  test(`${engine}: performance.web measures exactly the metrics the support table declares; throttled runs follow the table`, { skip }, async () => {
    const app = await site(CLEAN_START);
    try {
      const runs = async (performance: Record<string, unknown>) =>
        (
          await run(engine, app.url, {
            journeys: [plainJourney],
            audits: { checks: [{ id: 'performance.web', at: ['ready'], ...performance }] },
          })
        ).result.audits.runs.filter((entry) => entry.auditId === 'performance.web');
      const [plain] = await runs({});
      assert.ok(plain);
      const declared = ENGINE_PERFORMANCE_UNREPORTED[engine];
      if (declared === null) {
        assert.equal(plain.status, 'unsupported');
      } else {
        assert.ok(plain.performance, `${engine}: ${plain.status} ${plain.detail}`);
        assert.deepEqual(plain.performance.unsupported, declared);
        assert.equal(plain.performance.browser, engine);
      }
      const throttledConfig = { conditions: { cpuSlowdown: 2 } };
      const [throttled] = await runs(throttledConfig);
      const gap = engineAuditGap(
        engine,
        auditConfigSchema.parse({ id: 'performance.web', ...throttledConfig }),
      );
      if (gap) {
        assert.equal(throttled!.status, 'unsupported');
        assert.equal(throttled!.detail, gap);
        assert.equal(throttled!.performance, undefined);
      } else {
        assert.ok(throttled!.performance?.conditions.applied);
      }
    } finally {
      await app.close();
    }
  });

  test(`${engine}: CSS Typed OM lengths match the support table`, { skip }, async () => {
    const browser = await ENGINE_TYPES[engine].launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div id="x" style="padding:12px;margin:1.5em;border-radius:8px">x</div>',
      );
      const typed = await page.evaluate(() => {
        const element = document.getElementById('x')!;
        if (typeof element.computedStyleMap !== 'function') return null;
        const map = element.computedStyleMap();
        // Inline callbacks only: a named helper would need the bundler's
        // __name, which does not exist in the page.
        const [padding, margin, radius] = [
          'padding-top',
          'margin-top',
          'border-top-left-radius',
        ].map((property) => {
          const value = map.get(property);
          return value instanceof CSSUnitValue
            ? `${value.value}${value.unit}`
            : `untyped:${String(value)}`;
        });
        const parsed = CSSNumericValue.parse(
          String(map.get('border-top-left-radius')),
        );
        return {
          padding,
          margin,
          radius,
          parsedRadius:
            parsed instanceof CSSUnitValue
              ? `${parsed.value}${parsed.unit}`
              : null,
        };
      });
      const support = ENGINE_TYPED_OM[engine];
      assert.notEqual(support, 'untested');
      if (support === 'absent') {
        assert.equal(typed, null);
        return;
      }
      assert.ok(typed);
      assert.equal(typed.padding, '12px');
      assert.equal(typed.margin, '24px');
      assert.equal(typed.parsedRadius, '8px');
      assert.equal(
        typed.radius,
        support === 'lengths' ? '8px' : 'untyped:8px',
      );
    } finally {
      await browser.close();
    }
  });
}

test('runs on different engines are never compared as compatible', async (t) => {
  const ran = [...identities.keys()];
  if (ran.length < 2) {
    t.skip(
      `needs two engines that ran here; ran: ${ran.join(', ') || 'none'}`,
    );
    return;
  }
  const [a, b] = ran as [Engine, Engine];
  const { incompatibilities } = compatibility(
    identities.get(a)!,
    identities.get(b)!,
  );
  const fields = incompatibilities.map((entry) => entry.field);
  assert.ok(fields.includes('environment.browser.name'), fields.join(', '));
  // The browser is part of the suite configuration too.
  assert.ok(fields.includes('suite.hash'), fields.join(', '));
});

test('finding ids and visual baselines of one environment are kept apart per engine; Chromium ids are unchanged', () => {
  const result = (engine: Engine | null, environment?: string): Result =>
    ({
      journey: 'continue',
      viewport: 'desktop',
      attempt: 1,
      findings: [
        {
          kind: 'observed',
          category: 'overflow',
          description: 'x',
          step: 0,
          screenshot: '',
        },
      ],
      audits: { findings: [], runs: [], notReached: [] },
      ...(environment
        ? { environment: { name: environment, syntheticText: false } }
        : {}),
      ...(engine
        ? {
            identity: {
              environment: {
                browser: {
                  name: engine,
                  version: '1',
                  build: 'bundled',
                  headless: true,
                },
              },
            },
          }
        : {}),
    }) as unknown as Result;
  const id = (engine: Engine | null, environment?: string) =>
    findingInstances(result(engine, environment))[0]!.id;
  for (const environment of [undefined, 'dark']) {
    // Chromium, the default engine, keeps the ids results had before engines
    // were selectable, so stored comparisons and benchmark labels still match.
    assert.equal(id('chromium', environment), id(null, environment));
    assert.notEqual(id('webkit', environment), id('chromium', environment));
    assert.notEqual(id('firefox', environment), id('webkit', environment));
  }
  // The same environment on two engines never shares a visual baseline:
  // the baseline file is keyed by the rendering environment, engine included.
  const rendering = (name: Engine) => ({
    viewport: { width: 1280, height: 800 },
    browser: { name, version: '1', build: 'bundled', headless: true },
    os: { platform: 'darwin', arch: 'arm64', release: '27' },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezone: 'UTC',
    colorScheme: 'dark' as const,
    reducedMotion: 'no-preference' as const,
    capture: { fullPage: false, masks: [], protected: true },
  });
  assert.notEqual(
    environmentId(rendering('webkit')),
    environmentId(rendering('chromium')),
  );
});

test('kept defaults: Firefox suites are allowed with the engine.firefox gap, keyboard journeys stay refused on WebKit only, the environment cap is 24', () => {
  const base = {
    name: 'LOCAL defaults',
    baseURL: 'http://127.0.0.1:1',
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [plainJourney],
  };
  // Firefox runs are not refused: every audit reports unsupported and every
  // result carries the engine-wide gap.
  assert.equal(suiteSchema.safeParse({ ...base, browser: 'firefox' }).success, true);
  assert.ok(ENGINE_GAPS.firefox.some((gap) => gap.id === 'engine.firefox'));
  assert.deepEqual(Object.keys(KEYBOARD_JOURNEY_UNSUPPORTED), ['webkit']);
  assert.equal(MAX_RUN_COMBINATIONS, 24);
  const matrix = (max: number) =>
    suiteSchema.safeParse({
      ...base,
      environments: [{ name: 'light' }],
      matrix: { environments: ['light'], viewports: ['desktop'], max },
    }).success;
  assert.equal(matrix(24), true);
  assert.equal(matrix(25), false);
});
