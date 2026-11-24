import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_AUDITS,
  DEFAULT_AXE_TAGS,
  auditConfigSchema,
  type AuditConfig,
} from '../src/audits/config.js';
import type { DriverKind } from '../src/audits/contract.js';
import { JourneyAudits } from '../src/audits/run.js';
import {
  engineAuditGap,
  type BrowserEngine,
} from '../src/browser-support.js';
import {
  suiteSchema,
  type Action,
  type Check,
  type Observation,
  type Suite,
} from '../src/contracts.js';
import type { DriverAuditRequest, UISession } from '../src/drivers/types.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import { engineSkip } from './engines.js';

const DEFAULT_IDS = [
  'layout.horizontal-overflow',
  'accessibility.axe',
  'layout.responsive',
];

const webJourney = {
  id: 'find',
  goal: 'Find the result',
  persona: 'A visitor',
  startPath: '/',
  allowedPaths: ['/', '/done'],
  ready: {
    kind: 'visible',
    target: { by: 'role', role: 'heading', name: 'Home' },
  },
  success: [{ kind: 'path', pattern: '^/done$' }],
};

const webSuite = (extra: Record<string, unknown> = {}) =>
  suiteSchema.parse({
    name: 'defaults',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [webJourney],
    ...extra,
  }) as Suite;

const nativeSuite = (extra: Record<string, unknown> = {}) =>
  suiteSchema.parse({
    name: 'native',
    platform: 'macos',
    app: { bundleId: 'dev.example.app' },
    journeys: [
      {
        id: 'find',
        goal: 'Find',
        persona: 'A user',
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Home' },
        },
        success: [
          {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Home' },
          },
        ],
      },
    ],
    ...extra,
  }) as Suite;

const state = (step: number): Observation => ({
  step,
  url: `https://app.example/?step=${step}`,
  snapshot: '',
  screenshot: `step-${step}.png`,
  visibleViewport: {
    width: 800,
    height: 600,
    text: '',
    textTruncated: false,
    controls: [],
    canScrollUp: false,
    canScrollDown: false,
    scrollRegions: [],
  },
  fingerprint: `f${step}`,
  scroll: { x: 0, y: 0, containers: [] },
  horizontalOverflow: 0,
});

function fakeSession(
  options: {
    driver?: DriverKind;
    engine?: BrowserEngine;
    requests?: DriverAuditRequest[];
    runAudit?: boolean;
  } = {},
): UISession {
  const engine = options.engine;
  return {
    driver: options.driver,
    browserErrors: [],
    unauthorized: false,
    ...(engine
      ? {
          auditUnsupported: (config: AuditConfig) =>
            engineAuditGap(engine, config),
        }
      : {}),
    async start() {},
    setTimeout() {},
    location: () => 'https://app.example/done',
    async check() {
      return true;
    },
    async observe(step: number, screenshot: string) {
      return { ...state(step), screenshot };
    },
    async candidates() {
      return [];
    },
    async execute() {},
    async screenshot() {},
    async finish() {
      return { video: null };
    },
    ...(options.runAudit === false
      ? {}
      : {
          async runAudit(request: DriverAuditRequest) {
            options.requests?.push(request);
            return {
              complete: true,
              observations: 1,
              detail: null,
              findings: [],
            };
          },
        }),
  };
}

async function auditJourney(suite: Suite, session: UISession) {
  const runner = new JourneyAudits({
    suite,
    journey: suite.journeys[0]!,
    viewport: { name: 'desktop', width: 800, height: 600 },
    directory: '/tmp/run',
    session,
    log: async () => {},
  });
  runner.record(state(0));
  await runner.afterObservation(state(0));
  await runner.completion(1, 'final.png');
  return runner.finish();
}

const runsOf = (result: Awaited<ReturnType<typeof auditJourney>>) =>
  result.runs.map((run) => [run.auditId, run.checkpoint.id, run.status]);

test('a suite without an audits key gets overflow, axe and responsive layout with their own defaults', () => {
  const suite = webSuite();
  assert.equal(suite.audits.checks, undefined);
  assert.equal(suite.audits.failOn, 'serious');
  assert.deepEqual(
    DEFAULT_AUDITS.map((check) => check.id),
    DEFAULT_IDS,
  );
  assert.deepEqual(DEFAULT_AUDITS, [
    auditConfigSchema.parse({ id: 'layout.horizontal-overflow' }),
    auditConfigSchema.parse({
      id: 'accessibility.axe',
      disableRules: ['target-size'],
    }),
    auditConfigSchema.parse({ id: 'layout.responsive' }),
  ]);
  const axe = DEFAULT_AUDITS.find((check) => check.id === 'accessibility.axe');
  assert.ok(axe && axe.id === 'accessibility.axe');
  assert.deepEqual(axe.tags, DEFAULT_AXE_TAGS);
  assert.deepEqual(axe.disableRules, ['target-size']);
  const listed = auditConfigSchema.parse({ id: 'accessibility.axe' });
  assert.ok(listed.id === 'accessibility.axe');
  assert.equal(listed.disableRules, undefined);
  assert.deepEqual(axe.at, ['ready', 'completion']);
  assert.deepEqual(axe.include, []);
  assert.deepEqual(axe.exclude, []);
  const layout = DEFAULT_AUDITS.find(
    (check) => check.id === 'layout.responsive',
  );
  assert.ok(layout && layout.id === 'layout.responsive');
  assert.deepEqual(layout.at, ['ready', 'completion']);
  assert.deepEqual(layout.rules, ['clipping', 'occlusion', 'target-size']);
  const overflow = DEFAULT_AUDITS.find(
    (check) => check.id === 'layout.horizontal-overflow',
  );
  assert.deepEqual(overflow?.at, ['completion']);
});

for (const engine of ['chromium', 'webkit'] as const)
  test(`a ${engine} session without an audits key runs every default audit at its checkpoints`, async () => {
    const requests: DriverAuditRequest[] = [];
    const result = await auditJourney(
      webSuite(),
      fakeSession({ driver: 'playwright', engine, requests }),
    );
    assert.deepEqual(result.configured, DEFAULT_IDS);
    assert.deepEqual(runsOf(result), [
      ['accessibility.axe', 'ready', 'clean'],
      ['layout.responsive', 'ready', 'clean'],
      ['layout.horizontal-overflow', 'completion', 'clean'],
      ['accessibility.axe', 'completion', 'clean'],
      ['layout.responsive', 'completion', 'clean'],
    ]);
    const axe = requests.find(
      (request) => request.config.id === 'accessibility.axe',
    );
    assert.ok(axe && axe.config.id === 'accessibility.axe');
    assert.deepEqual(axe.config.tags, DEFAULT_AXE_TAGS);
    assert.deepEqual(result.notReached, []);
  });

test('an explicit audits.checks list replaces the defaults, and an empty list runs none', async () => {
  const only = await auditJourney(
    webSuite({
      audits: { checks: [{ id: 'layout.horizontal-overflow' }] },
    }),
    fakeSession({ driver: 'playwright', engine: 'chromium' }),
  );
  assert.deepEqual(only.configured, ['layout.horizontal-overflow']);
  assert.deepEqual(runsOf(only), [
    ['layout.horizontal-overflow', 'completion', 'clean'],
  ]);
  const suite = webSuite({ audits: { checks: [] } });
  assert.deepEqual(suite.audits.checks, []);
  const none = await auditJourney(
    suite,
    fakeSession({ driver: 'playwright', engine: 'chromium' }),
  );
  assert.deepEqual(none.configured, []);
  assert.deepEqual(none.runs, []);
  assert.deepEqual(none.notReached, []);
});

test('a default audit the engine or driver cannot run is left out, not reported unsupported', async () => {
  const firefox = await auditJourney(
    webSuite({ browser: 'firefox' }),
    fakeSession({ driver: 'playwright', engine: 'firefox' }),
  );
  assert.deepEqual(firefox.configured, []);
  assert.deepEqual(firefox.runs, []);
  const native = await auditJourney(
    nativeSuite(),
    fakeSession({ driver: 'macos' }),
  );
  assert.deepEqual(native.configured, []);
  assert.deepEqual(native.runs, []);
  assert.deepEqual(native.notReached, []);
  const noDriverAudits = await auditJourney(
    webSuite(),
    fakeSession({ driver: 'playwright', engine: 'chromium', runAudit: false }),
  );
  assert.deepEqual(noDriverAudits.configured, ['layout.horizontal-overflow']);
});

test('an audit listed explicitly keeps being reported unsupported where it cannot run', async () => {
  const listed = {
    audits: {
      checks: [{ id: 'accessibility.axe' }, { id: 'layout.responsive' }],
    },
  };
  const native = await auditJourney(
    nativeSuite(listed),
    fakeSession({ driver: 'macos' }),
  );
  assert.deepEqual(native.configured, [
    'accessibility.axe',
    'layout.responsive',
  ]);
  assert.deepEqual(runsOf(native), [
    ['accessibility.axe', 'ready', 'unsupported'],
    ['layout.responsive', 'ready', 'unsupported'],
    ['accessibility.axe', 'completion', 'unsupported'],
    ['layout.responsive', 'completion', 'unsupported'],
  ]);
  const firefox = await auditJourney(
    webSuite({ browser: 'firefox', ...listed }),
    fakeSession({ driver: 'playwright', engine: 'firefox' }),
  );
  assert.ok(firefox.runs.length);
  assert.ok(firefox.runs.every((run) => run.status === 'unsupported'));
  assert.match(firefox.runs[0]!.detail!, /Firefox/);
});

const pick: Models = {
  async plan() {
    return { objective: 'Continue', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return {
      type: 'choice',
      choice: actions[0]?.id ?? 'no_match',
      confidence: 1,
      probabilities: {},
    };
  },
};

test('a macOS suite without an audits key gets no unsupported audit and no audit gap in its verdict', async () => {
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-default-audits-')),
    'run',
  );
  const suite = nativeSuite();
  const [result] = await runSuite(suite, pick, {
    directory,
    driver: {
      async openSession() {
        return {
          ...fakeSession({ driver: 'macos', runAudit: false }),
          async observe(step: number, screenshot: string) {
            return {
              ...state(step),
              url: 'macos-app://dev.example.app/Home',
              screenshot,
            };
          },
          async inScope() {
            return true;
          },
        };
      },
      async close() {},
    },
  });
  assert.equal(result!.status, 'passed');
  assert.deepEqual(result!.audits.configured, []);
  assert.deepEqual(result!.audits.runs, []);
  const unsupported = result!.quality.unsupported.map((gap) => gap.id);
  for (const id of DEFAULT_IDS) assert.ok(!unsupported.includes(id), id);
  assert.doesNotMatch(result!.quality.reason, /configured audit/);
});

test('a native suite that passes with an explicit state-checks audit still passes', async () => {
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-default-audits-')),
    'run',
  );
  const heading: Check = {
    kind: 'visible',
    target: { by: 'role', role: 'heading', name: 'Home' },
  };
  const suite = nativeSuite({
    audits: { checks: [{ id: 'journey.state-checks' }] },
  });
  suite.journeys[0]!.states = [
    { name: 'home', when: heading, expect: [heading] },
  ];
  const [result] = await runSuite(suite, pick, {
    directory,
    driver: {
      async openSession() {
        return {
          ...fakeSession({ driver: 'macos', runAudit: false }),
          async inScope() {
            return true;
          },
        };
      },
      async close() {},
    },
  });
  assert.equal(result!.status, 'passed');
  assert.equal(result!.quality.verdict, 'pass', result!.quality.reason);
});

const SMALL_TARGETS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Editor</title><style>body{font:16px sans-serif;margin:16px;color:#111;background:#fff}.toolbar{display:flex;gap:2px;margin:12px 0}.toolbar button{width:18px;height:18px;padding:0;border:1px solid #333;background:#fff;color:#111;font-size:10px}a{color:#0645ad}</style></head><body><main><h1>Home</h1><div class="toolbar" role="toolbar" aria-label="Formatting"><button aria-label="Bold">B</button><button aria-label="Italic">I</button><button aria-label="Underline">U</button></div><p><a href="/done">Continue</a></p></main></body></html>`;
const DONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title></head><body><main><h1>Done</h1><p>Saved</p></main></body></html>`;

async function smallTargetSite() {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/done' ? DONE : SMALL_TARGETS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const linkFirst: Models = {
  async plan() {
    return { objective: 'Continue', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions: Action[]) {
    return {
      type: 'choice',
      choice:
        actions.find((action) => action.kind === 'link')?.id ?? 'no_match',
      confidence: 1,
      probabilities: {},
    };
  },
};

for (const engine of ['chromium', 'webkit'] as const)
  test(`default audits run on a real ${engine} page, and targets under 24px are moderate findings that do not fail quality`, async (t) => {
    const skip = await engineSkip(engine);
    if (skip) {
      t.skip(skip);
      return;
    }
    const site = await smallTargetSite();
    try {
      const suite = suiteSchema.parse({
        name: 'small-targets',
        baseURL: site.url,
        browser: engine,
        viewports: [{ name: 'mobile', width: 390, height: 844 }],
        journeys: [
          {
            ...webJourney,
            id: 'continue',
            maxSteps: 3,
            maxDurationMs: 60000,
          },
        ],
      });
      const directory = join(
        await mkdtemp(join(tmpdir(), 'ui-ux-default-audits-')),
        'run',
      );
      const [result] = await runSuite(suite, linkFirst, { directory });
      assert.equal(result!.status, 'passed', result!.reason);
      assert.deepEqual(result!.audits.configured, DEFAULT_IDS);
      const runs = result!.audits.runs.map((run) => [
        run.auditId,
        run.checkpoint.id,
      ]);
      assert.deepEqual(runs, [
        ['accessibility.axe', 'ready'],
        ['layout.responsive', 'ready'],
        ['layout.horizontal-overflow', 'completion'],
        ['accessibility.axe', 'completion'],
        ['layout.responsive', 'completion'],
      ]);
      assert.ok(
        result!.audits.runs.every(
          (run) => run.status !== 'unsupported' && run.status !== 'error',
        ),
        JSON.stringify(result!.audits.runs.map((run) => run.detail)),
      );
      const sizes = result!.audits.findings.filter(
        (finding) => finding.ruleId === 'target-size',
      );
      assert.ok(sizes.length, 'the 18px toolbar buttons are found');
      assert.ok(
        sizes.every((finding) => finding.auditId === 'layout.responsive'),
      );
      for (const run of result!.audits.runs)
        if (run.auditId === 'accessibility.axe')
          assert.ok(
            run.limitations.includes('axe rules not run: target-size'),
            JSON.stringify(run.limitations),
          );
      for (const finding of sizes) {
        assert.equal(finding.severity, 'moderate');
        assert.equal(finding.gating, false);
      }
      assert.deepEqual(
        result!.audits.findings.filter((finding) => finding.gating),
        [],
      );
      assert.equal(result!.audits.failOn, 'serious');
      assert.equal(result!.quality.verdict, 'pass', result!.quality.reason);
      const executed = result!.quality.executed.map((check) => check.id);
      for (const id of DEFAULT_IDS) assert.ok(executed.includes(id), id);
      assert.ok(
        !result!.quality.unsupported.some(
          (gap) => gap.id === 'accessibility.audit',
        ),
      );
    } finally {
      await site.close();
    }
  });

test('an explicitly listed axe scan keeps its own serious target-size rule', async () => {
  const site = await smallTargetSite();
  try {
    const suite = suiteSchema.parse({
      name: 'small-targets-axe',
      baseURL: site.url,
      viewports: [{ name: 'mobile', width: 390, height: 844 }],
      audits: { checks: [{ id: 'accessibility.axe' }] },
      journeys: [
        { ...webJourney, id: 'continue', maxSteps: 3, maxDurationMs: 60000 },
      ],
    });
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-default-audits-')),
      'run',
    );
    const [result] = await runSuite(suite, linkFirst, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    const sizes = result!.audits.findings.filter(
      (finding) => finding.ruleId === 'target-size',
    );
    assert.ok(sizes.length);
    for (const finding of sizes) {
      assert.equal(finding.auditId, 'accessibility.axe');
      assert.equal(finding.severity, 'serious');
      assert.equal(finding.gating, true);
    }
    assert.equal(result!.quality.verdict, 'fail');
  } finally {
    await site.close();
  }
});
