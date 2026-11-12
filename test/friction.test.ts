import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suiteSchema, type Action, type Choice } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import { parseResults } from '../src/results.js';
import {
  FRICTION_NOTE,
  FrictionRecorder,
  computeFriction,
  eventLogRuns,
  type Friction,
} from '../src/friction/index.js';

// --- Pure computation over a hand-written event stream ------------------

type Raw = [event: string, data: Record<string, unknown>];
const obs = (step: number, path: string): Raw => [
  'observation',
  {
    journey: 'j',
    viewport: 'desktop',
    step,
    url: `https://app.example${path}`,
    screenshot: `/runs/r/j-desktop/step-${String(step).padStart(3, '0')}.png`,
    fingerprint: `fp-${step}`,
    snapshot: 'not read',
  },
];
const link = (href: string, name: string) => ({
  kind: 'link',
  id: 'a0',
  description: `Open ${name}`,
  target: { by: 'role', role: 'link', name },
  href: `https://app.example${href}`,
});
const acted = (
  step: number,
  action: Record<string, unknown>,
  extra: { source?: string; changed?: boolean; error?: string | null } = {},
): Raw => [
  'action_result',
  {
    journey: 'j',
    viewport: 'desktop',
    step,
    action,
    source: extra.source ?? 'selector',
    changed: extra.changed ?? true,
    error: extra.error ?? null,
    durationMs: 12,
  },
];
const decided = (step: number, choice: string): Raw => [
  'decision',
  { step, candidates: [], decision: { type: 'choice', choice } },
];
const planned = (
  step: number,
  reasons: string[],
  concerns: number = 0,
): Raw => [
  'plan',
  {
    step,
    refreshReasons: reasons,
    plan: {
      objective: 'x',
      concerns: Array.from({ length: concerns }, () => ({
        symptom: 's',
        userImpact: 'u',
      })),
    },
  },
];
const loop = (
  step: number,
  action: string,
  visits: number,
  outcome: string,
): Raw => ['loop_check', { step, action, visits, outcome, key: 'k', limit: 3 }];

function record(raws: Raw[], first = 1): FrictionRecorder {
  const recorder = new FrictionRecorder();
  raws.forEach(([event, data], index) =>
    recorder.record(first + index, event, data),
  );
  return recorder;
}

const click = {
  kind: 'click',
  id: 'a1',
  description: 'Click Refresh news',
  target: { by: 'role', role: 'button', name: 'Refresh news' },
};

// A run with one of each friction kind, starting at events.jsonl line 10.
const wander: Raw[] = [
  ['journey_start', { journey: 'j', viewport: 'desktop', attempt: 1 }], // 10
  obs(0, '/'), // 11
  planned(0, ['initial'], 2), // 12
  decided(0, 'a0'), // 13
  loop(0, 'Open Preview', 1, 'dispatch'), // 14
  acted(0, link('/preview/install', 'Preview')), // 15
  obs(1, '/preview/install'), // 16
  [
    'detour',
    {
      step: 1,
      path: '/preview/install',
      description: 'a preview, not the guide',
      visits: 1,
    },
  ], // 17
  decided(1, 'a0'), // 18
  loop(1, 'Go back to the previous page (/)', 1, 'dispatch'), // 19
  acted(1, {
    kind: 'back',
    id: 'a0',
    description: 'Go back to the previous page (/)',
    url: 'https://app.example/',
  }), // 20
  obs(2, '/'), // 21
  decided(2, 'a1'), // 22
  loop(2, 'Click Refresh news', 1, 'dispatch'), // 23
  acted(2, click, { changed: false }), // 24
  obs(3, '/'), // 25
  decided(3, 'a1'), // 26
  loop(3, 'Click Refresh news', 2, 'replan'), // 27
  obs(4, '/'), // 28
  planned(4, ['revisited-state']), // 29
  decided(4, 'a1'), // 30
  loop(4, 'Click Refresh news', 2, 'dispatch'), // 31
  acted(4, click, { changed: false }), // 32
  obs(5, '/'), // 33
  decided(5, 'a2'), // 34
  acted(5, link('/docs', 'Documentation'), {
    error: 'Stale observation: link destination changed',
  }), // 35
  obs(6, '/'), // 36
  decided(6, 'a2'), // 37
  acted(6, link('/docs', 'Documentation')), // 38
  obs(7, '/docs'), // 39
  planned(7, ['navigation']), // 40
  decided(7, 'a0'), // 41
  acted(7, link('/', 'Home')), // 42
  obs(8, '/'), // 43
  planned(8, ['navigation']), // 44
  decided(8, 'no_match'), // 45
  obs(9, '/'), // 46
  planned(9, ['selector-no-match']), // 47
  decided(9, 'no_match'), // 48
  [
    'recovery',
    {
      step: 9,
      reason: 'Two consecutive no_match decisions',
      attempt: 1,
      limit: 2,
    },
  ], // 49
  loop(9, 'Scroll down in page', 1, 'dispatch'), // 50
  acted(
    9,
    {
      kind: 'scroll',
      id: 'a5',
      description: 'Scroll down in page',
      direction: 'down',
      region: 'page',
      point: { x: 1, y: 1 },
    },
    { source: 'recovery' },
  ), // 51
  obs(10, '/'), // 52
  decided(10, 'a3'), // 53
  acted(10, { kind: 'wait', id: 'a3', description: 'Wait briefly' }, {
    changed: false,
  }), // 54
  obs(11, '/'), // 55
  decided(11, 'a4'), // 56
  acted(11, link('/docs/install', 'All guides')), // 57
  obs(12, '/docs/install'), // 58
  ['model_call', { role: 'planner', durationMs: 5 }], // 59, ignored
];

test('friction counts each kind from the event stream and links it to observed steps', () => {
  const friction = computeFriction(record(wander, 10), {});
  assert.equal(friction.basis, 'agent_run');
  assert.equal(friction.note, FRICTION_NOTE);
  assert.match(friction.note, /not human usability performance/);
  assert.deepEqual(friction.events, {
    first: 11,
    last: 58,
    considered: 48,
    unparsed: 0,
  });
  assert.deepEqual(friction.actions, {
    executed: 10,
    product: 8,
    waits: 1,
    recovery: 1,
  });
  assert.deepEqual(friction.overhead, {
    plannerRefreshes: 5,
    refreshReasons: {
      initial: 1,
      'revisited-state': 1,
      navigation: 2,
      'selector-no-match': 1,
    },
    noMatchDecisions: 2,
    revisitReplans: 1,
    recoveryActions: 1,
  });
  assert.deepEqual(friction.counts, {
    backtracks: 2,
    repeats: 1,
    recoveries: 1,
    detours: 1,
    failedAttempts: 1,
    noEffect: 2,
  });
  const byKind = (kind: string) =>
    friction.items.filter((item) => item.kind === kind);
  const [history, navigation] = byKind('backtrack');
  assert.deepEqual(history, {
    kind: 'backtrack',
    actor: 'product',
    description: 'Go back to the previous page (/)',
    detail: 'browser history back to https://app.example/',
    line: 20,
    step: 1,
    url: 'https://app.example/preview/install',
    before: '/runs/r/j-desktop/step-001.png',
    after: '/runs/r/j-desktop/step-002.png',
  });
  assert.equal(navigation!.line, 42);
  assert.equal(
    navigation!.detail,
    'returned to https://app.example/, observed earlier at step 0',
  );
  assert.equal(byKind('repeat')[0]!.line, 31);
  assert.equal(byKind('repeat')[0]!.detail, 'visit 2 of this action in this state (dispatch)');
  assert.equal(byKind('recovery')[0]!.actor, 'overhead');
  assert.equal(byKind('recovery')[0]!.line, 49);
  assert.equal(byKind('detour')[0]!.line, 17);
  assert.equal(byKind('detour')[0]!.before, '/runs/r/j-desktop/step-001.png');
  const [failed] = byKind('failed_attempt');
  assert.equal(failed!.line, 35);
  assert.match(failed!.detail!, /^stale: Stale observation/);
  // The wait that changed nothing is not a no-effect action.
  assert.deepEqual(
    byKind('no_effect').map((item) => item.line),
    [24, 32],
  );
  // Items are in event order.
  assert.deepEqual(
    friction.items.map((item) => item.line),
    [...friction.items.map((item) => item.line)].sort((a, b) => a - b),
  );
  assert.deepEqual(friction.hypotheses, [{ line: 12, step: 0, concerns: 2 }]);
  assert.equal(friction.reference, null);
});

test('the rubric is explicit, never scores and stays pending human review', () => {
  const friction = computeFriction(record(wander), {});
  assert.deepEqual(
    friction.rubric.map((entry) => entry.dimension),
    ['discoverability', 'feedback', 'clarity', 'recovery'],
  );
  for (const entry of friction.rubric) {
    assert.equal(entry.review, 'pending');
    assert.ok(entry.question.endsWith('?'));
    assert.ok(!('score' in entry));
  }
  const feedback = friction.rubric.find(
    (entry) => entry.dimension === 'feedback',
  )!;
  assert.deepEqual(feedback.signals, [
    { signal: 'noEffect', count: 2 },
    { signal: 'repeats', count: 1 },
  ]);
  assert.equal(feedback.status, 'signals_observed');
  const quiet = computeFriction(
    record([obs(0, '/'), acted(0, link('/docs', 'Docs')), obs(1, '/docs')]),
    {},
  );
  assert.ok(quiet.rubric.every((entry) => entry.status === 'no_signals'));
});

const referencePaths = [
  {
    name: 'via-docs',
    waypoints: [
      { kind: 'page', pattern: '^/docs$' },
      { kind: 'action', action: 'link', to: '^/docs/install$' },
    ],
    expectedActions: 2,
  },
  {
    name: 'via-search',
    waypoints: [
      { kind: 'action', description: 'Search' },
      { kind: 'page', pattern: '^/search$' },
      { kind: 'page', pattern: '^/docs/install$' },
    ],
    expectedActions: 2,
  },
];

const journeyWith = (paths: unknown) =>
  suiteSchema.parse({
    name: 'friction',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [
      {
        id: 'j',
        goal: 'Find the guide',
        persona: 'A reader',
        startPath: '/',
        allowedPaths: ['/'],
        ready: { kind: 'path', pattern: '^/$' },
        success: [{ kind: 'path', pattern: '^/docs/install$' }],
        referencePaths: paths,
      },
    ],
  }).journeys[0]!;

test('alternate reference paths: the run is compared with the closest, and extra steps are only counted', () => {
  const journey = journeyWith(referencePaths);
  const viaSearch = computeFriction(
    record([
      obs(0, '/'),
      acted(0, link('/search', 'Search')),
      obs(1, '/search'),
      acted(1, link('/docs/install', 'Install result')),
      obs(2, '/docs/install'),
    ]),
    journey,
  );
  const reference = viaSearch.reference!;
  assert.equal(reference.closest, 'via-search');
  const search = reference.paths.find((path) => path.name === 'via-search')!;
  assert.equal(search.followed, true);
  assert.equal(search.matched, 3);
  assert.equal(search.total, 3);
  assert.equal(search.expectedActions, 2);
  assert.equal(search.comparedActions, 2);
  assert.equal(search.extraActions, 0);
  assert.deepEqual(
    search.waypoints.map((waypoint) => waypoint.line),
    [2, 3, 5],
  );
  const docs = reference.paths.find((path) => path.name === 'via-docs')!;
  assert.equal(docs.followed, false);
  assert.equal(docs.matched, 1);
  assert.equal(docs.waypoints[0]!.matched, false);
  assert.match(reference.note, /Extra actions alone do not establish/);

  // The docs route with a detour, a repeat and a recovery on the way:
  // followed, with extra actions counted but not judged.
  const viaDocs = computeFriction(record(wander), journey).reference!;
  assert.equal(viaDocs.closest, 'via-docs');
  const followed = viaDocs.paths.find((path) => path.name === 'via-docs')!;
  assert.equal(followed.followed, true);
  assert.equal(followed.expectedActions, 2);
  assert.equal(followed.comparedActions, 8);
  assert.equal(followed.extraActions, 6);
});

test('unordered waypoints and allowances', () => {
  const run = record([
    obs(0, '/'),
    acted(0, {
      kind: 'click',
      id: 'a0',
      description: 'Click Accept cookies',
      target: { by: 'role', role: 'button', name: 'Accept cookies' },
    }),
    obs(1, '/'),
    acted(1, link('/b', 'B')),
    obs(2, '/b'),
    acted(2, link('/a', 'A')),
    obs(3, '/a'),
  ]);
  const paths = (ordered: boolean) =>
    journeyWith([
      {
        name: 'a-and-b',
        ordered,
        waypoints: [
          { kind: 'page', pattern: '^/a$' },
          { kind: 'page', pattern: '^/b$' },
        ],
        expectedActions: 2,
        allow: [{ description: 'cookies' }],
      },
    ]);
  const strict = computeFriction(run, paths(true)).reference!.paths[0]!;
  assert.equal(strict.followed, false);
  assert.equal(strict.matched, 1);
  const any = computeFriction(run, paths(false)).reference!.paths[0]!;
  assert.equal(any.followed, true);
  assert.equal(any.ordered, false);
  // The allowed cookie banner click is not compared.
  assert.equal(any.comparedActions, 2);
  assert.equal(any.allowedActions, 1);
  assert.equal(any.extraActions, 0);
});

test('reference paths are validated when the suite is parsed', () => {
  assert.throws(
    () =>
      journeyWith([
        { name: 'x', waypoints: [{ kind: 'page', pattern: '(' }] },
      ]),
    /Invalid regex/,
  );
  assert.throws(
    () =>
      journeyWith([
        { name: 'x', waypoints: [{ kind: 'action' }] },
      ]),
    /action waypoint needs/,
  );
  assert.throws(
    () =>
      journeyWith([
        { name: 'x', waypoints: [{ kind: 'page', pattern: 'a' }] },
        { name: 'x', waypoints: [{ kind: 'page', pattern: 'b' }] },
      ]),
    /unique/,
  );
  assert.throws(
    () => journeyWith([{ name: 'x', waypoints: [], extra: 1 }]),
    /waypoints|Unrecognized/,
  );
  // Optional: a journey without reference paths has no comparison.
  assert.equal(journeyWith(undefined).referencePaths, undefined);
});

test('an unparsable friction event is counted, not silently dropped', () => {
  const recorder = record([
    obs(0, '/'),
    ['action_result', { step: 'zero' }],
    ['console_error', { message: 'ignored' }],
  ]);
  const friction = computeFriction(recorder, {});
  assert.equal(friction.events.unparsed, 1);
  assert.equal(friction.events.considered, 1);
});

// --- Real browser runs with scripted decisions (no model calls) ----------

const html = (body: string) =>
  `<!doctype html><html lang="en"><title>Friction fixture</title><style>body{font:18px system-ui;margin:40px}a,button{display:block;margin:12px 0}</style>${body}</html>`;
const PAGES: Record<string, string> = {
  '/': html(
    '<h1>Example product</h1><a href="/docs">Documentation</a><a href="/search">Search</a><a href="/preview/install">Preview ACME-CASE-104233</a><button type="button">Refresh news</button><div style="height:1100px"></div><a href="/docs/install">All guides</a>',
  ),
  '/docs': html(
    '<h1>Documentation</h1><a href="/docs/install">Installation guide</a><a href="/">Home ACME-CASE-104233</a>',
  ),
  '/search': html(
    '<h1>Search</h1><a href="/docs/install">Install result</a>',
  ),
  '/preview/install': html('<h1>Install preview</h1><p>Coming soon.</p>'),
  '/docs/install': html('<h1>Install the example product</h1>'),
};

async function site() {
  const server = createServer((request, response) => {
    const page = PAGES[new URL(request.url ?? '/', 'http://x').pathname];
    response.statusCode = page ? 200 : 404;
    response.setHeader('Content-Type', 'text/html');
    response.end(page ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const chose = (choice: string, actions: Action[]): Choice => ({
  type: 'choice',
  choice,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
    ['no_match', choice === 'no_match' ? 1 : 0],
  ]),
});

// Picks by intent: a link destination path, 'back', 'click' or 'no_match'.
// Models see the provider (redacted) view, so links are matched by path.
function pick(intent: string, actions: Action[]): string {
  if (intent === 'no_match') return 'no_match';
  const action = actions.find((candidate) =>
    intent === 'back' || intent === 'click'
      ? candidate.kind === intent
      : candidate.kind === 'link' &&
        new URL(candidate.href).pathname === intent,
  );
  if (!action)
    throw new Error(
      `Scripted intent ${intent} not offered: ${actions.map((a) => a.description).join(' | ')}`,
    );
  return action.id;
}

// Each journey's decisions, one intent per selector call.
const SCRIPTS: Record<string, string[]> = {
  'via-docs': ['/docs', '/docs/install'],
  'via-search': ['/search', '/docs/install'],
  wander: [
    '/preview/install', // a configured detour
    'back', // backtrack through browser history
    'click', // a no-op button
    'click', // same state again: the runner replans first
    'click', // dispatched again: a repeat
    '/docs',
    '/', // backtrack by navigation
    'no_match',
    'no_match', // two no_match: recovery scroll
    '/docs/install',
  ],
};

function scripted(): Models & {
  calls: Record<string, number>;
  // Journeys the adapter received that carried reference paths.
  sawReferencePaths: string[];
} {
  const calls: Record<string, number> = {};
  const sawReferencePaths: string[] = [];
  const seen = (journey: { id: string; referencePaths?: unknown }) => {
    if ('referencePaths' in journey) sawReferencePaths.push(journey.id);
  };
  return {
    calls,
    sawReferencePaths,
    async plan(journey, _observation, _history, _budget, _actions, context) {
      seen(journey);
      // One model concern on the first plan of the wandering journey.
      return {
        objective: 'Find the installation guide',
        concerns:
          journey.id === 'wander' && context?.reasons.includes('initial')
            ? [
                {
                  symptom: 'The preview link looks like the guide',
                  userImpact: 'Readers may open the wrong page',
                },
              ]
            : [],
      };
    },
    async choose(journey, _observation, _plan, actions) {
      seen(journey);
      const index = calls[journey.id] ?? 0;
      calls[journey.id] = index + 1;
      const intent = SCRIPTS[journey.id]![index];
      if (!intent) throw new Error(`Script for ${journey.id} ran out`);
      return chose(pick(intent, actions), actions);
    },
  };
}

test('real runs: friction reconciles exactly with events.jsonl, covers alternate paths, a backtrack, a repeat and a recovery, and is redacted', async () => {
  const app = await site();
  const directory = join(
    await mkdtemp(join(tmpdir(), 'ui-ux-friction-')),
    'run',
  );
  const journey = (id: string) => ({
    id,
    goal: 'Find the installation instructions',
    persona: 'A new product user',
    startPath: '/',
    allowedPaths: ['/', '/docs', '/search', '/preview'],
    ready: {
      kind: 'visible',
      target: { by: 'role', role: 'heading', name: 'Example product' },
    },
    success: [{ kind: 'path', pattern: '^/docs/install$' }],
    interactions: [
      {
        kind: 'click',
        target: { by: 'role', role: 'button', name: 'Refresh news' },
        description: 'Refresh news',
      },
    ],
    detours: [
      { pattern: '^/preview/', description: 'a preview, not the guide' },
    ],
    referencePaths,
    maxSteps: 20,
    maxDurationMs: 60000,
  });
  const suite = suiteSchema.parse({
    name: 'Friction fixture',
    baseURL: app.url,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    evidence: {
      redact: [{ pattern: 'ACME-CASE-\\d{6}', label: 'case-id' }],
    },
    journeys: [journey('via-docs'), journey('via-search'), journey('wander')],
  });
  try {
    const models = scripted();
    const returned = await runSuite(suite, models, { directory });
    assert.deepEqual(
      returned.map((result) => [result.journey, result.status]),
      [
        ['via-docs', 'passed'],
        ['via-search', 'passed'],
        ['wander', 'passed'],
      ],
      JSON.stringify(returned.map((result) => result.reason)),
    );
    assert.deepEqual(models.calls, {
      'via-docs': 2,
      'via-search': 2,
      wander: 10,
    });
    // Reference paths are reviewed answers: no model adapter, built-in or
    // custom, receives them.
    assert.deepEqual(models.sawReferencePaths, []);
    const results = parseResults(
      await readFile(join(directory, 'results.json'), 'utf8'),
    );
    const log = await readFile(join(directory, 'events.jsonl'), 'utf8');
    const runs = eventLogRuns(log);
    assert.equal(runs.length, 3);
    for (const [index, result] of results.entries()) {
      const run = runs[index]!;
      assert.equal(run.journey, result.journey);
      assert.equal(run.viewport, result.viewport);
      assert.equal(run.attempt, result.attempt);
      // Recomputed from the written event log, the summary is identical.
      const recomputed = computeFriction(
        run,
        suite.journeys.find((entry) => entry.id === result.journey)!,
      );
      assert.deepEqual(result.friction, recomputed);
      // Every item's line is that event in events.jsonl.
      const lines = log.split('\n');
      for (const item of result.friction!.items) {
        const event = JSON.parse(lines[item.line - 1]!);
        assert.equal(event.data.step, item.step);
      }
      // The per-run result.json carries the same summary.
      const own = JSON.parse(
        await readFile(
          join(directory, `${result.journey}-desktop`, 'result.json'),
          'utf8',
        ),
      );
      assert.deepEqual(own.friction, result.friction);
    }
    const [viaDocs, viaSearch, wander] = results.map(
      (result) => result.friction!,
    ) as [Friction, Friction, Friction];
    // Alternate valid paths: each direct run follows its own reference path.
    for (const [friction, name] of [
      [viaDocs, 'via-docs'],
      [viaSearch, 'via-search'],
    ] as const) {
      assert.equal(friction.reference!.closest, name);
      const path = friction.reference!.paths.find(
        (entry) => entry.name === name,
      )!;
      assert.equal(path.followed, true);
      assert.equal(path.extraActions, 0);
      assert.equal(friction.actions.product, 2);
      assert.deepEqual(friction.counts, {
        backtracks: 0,
        repeats: 0,
        recoveries: 0,
        detours: 0,
        failedAttempts: 0,
        noEffect: 0,
      });
    }
    // The wandering run.
    assert.deepEqual(wander.counts, {
      backtracks: 2,
      repeats: 1,
      recoveries: 1,
      detours: 1,
      failedAttempts: 0,
      noEffect: 2,
    });
    assert.deepEqual(wander.actions, {
      executed: 8,
      product: 7,
      waits: 0,
      recovery: 1,
    });
    assert.equal(wander.overhead.noMatchDecisions, 2);
    assert.equal(wander.overhead.revisitReplans, 1);
    assert.equal(wander.overhead.recoveryActions, 1);
    assert.deepEqual(
      wander.items
        .filter((item) => item.kind === 'backtrack')
        .map((item) => item.detail!.split(' ')[0]),
      ['browser', 'returned'],
    );
    assert.equal(wander.hypotheses.length, 1);
    assert.equal(wander.hypotheses[0]!.concerns, 1);
    const docsPath = wander.reference!.paths.find(
      (entry) => entry.name === 'via-docs',
    )!;
    assert.equal(docsPath.followed, true);
    assert.equal(docsPath.extraActions, 5);
    // Friction never changes the functional outcome or the quality verdict.
    assert.equal(results[2]!.status, 'passed');
    // Redacted like other evidence text.
    const [history, home] = wander.items.filter(
      (item) => item.kind === 'backtrack',
    );
    assert.ok(history!.url!.endsWith('/preview/install'));
    assert.equal(home!.description, 'Open Home [REDACTED:case-id]');
    const written = await readFile(join(directory, 'results.json'), 'utf8');
    assert.ok(!written.includes('ACME-CASE-104233'));
    const report = await readFile(join(directory, 'report.html'), 'utf8');
    assert.ok(!report.includes('ACME-CASE-104233'));
    assert.match(report, /Task friction \(agent run\)/);
    assert.match(report, /not human usability performance/);
    assert.match(report, /Extra actions alone do not establish/);
    assert.match(report, /events\.jsonl line \d+/);
    assert.match(report, /pending human review/);
  } finally {
    await app.close();
  }
});
