// Run identity, finding identity, compatible-run comparison and gates
// (src/identity.ts, src/compare.ts, src/gate.ts, npm run compare). Runs come
// from an in-memory driver, so every scenario is deterministic and needs no
// browser or model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  suiteSchema,
  type Action,
  type Observation,
  type Suite,
} from '../src/contracts.js';
import type { UIDriver, UISession } from '../src/drivers/types.js';
import type { Models } from '../src/models.js';
import { parseResults, type Result } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import {
  ENGINE_VERSION,
  buildFrom,
  modelIdentity,
  runIdentitySchema,
  suiteHash,
} from '../src/identity.js';
import { Redactor } from '../src/evidence/redact.js';
import {
  comparisonSchema,
  compareRuns,
  findingInstances,
  loadRun,
  type Comparison,
} from '../src/compare.js';
import { gateSchema, type GateInput } from '../src/gate.js';
import { writeComparison } from '../src/compare-files.js';

const exec = promisify(execFile);
const PLANTED = 'planted-secret-value-7f3a9c';

const continueAction: Extract<Action, { kind: 'click' }> = {
  kind: 'click',
  id: 'a0',
  description: 'Continue',
  target: { by: 'role', role: 'button', name: 'Continue' },
};

type Scenario = {
  // Horizontal overflow (px) of every observed state: > 1 is a serious
  // layout.horizontal-overflow violation at completion.
  overflow?: number;
  // The journey never reaches its asserted outcome.
  fails?: boolean;
  browserVersion?: string;
};

function fakeDriver(scenario: Scenario): UIDriver {
  return {
    environment: () => ({
      driver: 'fake',
      browser: {
        name: 'chromium',
        version: scenario.browserVersion ?? '140.0.0.0',
        build: 'bundled',
        headless: true,
      },
    }),
    async openSession(): Promise<UISession> {
      let executed = 0;
      const done = () => !scenario.fails && executed >= 1;
      return {
        browserErrors: [],
        policyBlocks: [],
        unauthorized: false,
        async start() {},
        setTimeout() {},
        location: () =>
          done()
            ? 'https://app.example/done?session=volatile'
            : 'https://app.example/',
        async check(condition) {
          if (condition.kind === 'visible') return true;
          return done();
        },
        async observe(step, screenshot): Promise<Observation> {
          return {
            step,
            url: done()
              ? 'https://app.example/done?session=volatile'
              : 'https://app.example/',
            snapshot: '- button "Continue"',
            screenshot,
            visibleViewport: {
              width: 800,
              height: 600,
              text: 'Continue',
              textTruncated: false,
              controls: [{ role: 'button', name: 'Continue', disabled: false }],
              canScrollUp: false,
              canScrollDown: false,
              scrollRegions: [],
            },
            fingerprint: `state-${executed}`,
            scroll: { x: 0, y: 0, containers: [] },
            horizontalOverflow: done() ? (scenario.overflow ?? 0) : 0,
          };
        },
        async candidates() {
          return [{ ...continueAction }];
        },
        async execute() {
          executed++;
        },
        async screenshot() {},
        async inScope() {
          return true;
        },
        async finish() {
          return { video: null, trace: null };
        },
      };
    },
    async close() {},
  };
}

const models: Models = {
  async plan() {
    return { objective: 'Continue', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return {
      type: 'choice',
      choice: actions[0]!.id,
      confidence: 1,
      probabilities: { [actions[0]!.id]: 1 },
    };
  },
};

function fixtureSuite(
  overrides: { goal?: string; baseURL?: string } = {},
): Suite {
  return suiteSchema.parse({
    name: 'Compare fixture',
    baseURL: overrides.baseURL ?? 'https://app.example',
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    journeys: [
      {
        id: 'finish',
        goal: overrides.goal ?? 'Finish',
        persona: 'Visitor',
        startPath: '/',
        allowedPaths: ['/', '/done'],
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Start' },
        },
        success: [{ kind: 'path', pattern: '^/done$' }],
        interactions: [
          {
            kind: 'click',
            target: continueAction.target,
            description: 'Continue',
          },
        ],
        maxSteps: 3,
        maxDurationMs: 2000,
      },
    ],
  });
}

const root = await mkdtemp(join(tmpdir(), 'ui-ux-compare-'));
let runs = 0;

async function run(
  scenario: Scenario,
  options: {
    suite?: Suite;
    build?: string;
    modelIdentity?: ReturnType<typeof modelIdentity> | null;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const directory = join(root, `run-${++runs}`);
  const results = await runSuite(options.suite ?? fixtureSuite(), models, {
    directory,
    driver: fakeDriver(scenario),
    build: { id: options.build ?? `build-${runs}`, source: 'option' },
    modelIdentity: options.modelIdentity,
    env: options.env ?? {},
  });
  return { directory, results };
}

// Rewrites a run's results.json (simulating audit outcomes the fake driver
// cannot produce) and returns the directory.
async function edit(directory: string, change: (results: Result[]) => void) {
  const file = join(directory, 'results.json');
  const results = parseResults(await readFile(file, 'utf8'));
  change(results);
  await writeFile(file, JSON.stringify(results, null, 2));
  return directory;
}

async function compare(base: string, candidate: string, gate: GateInput = {}) {
  return compareRuns(
    await loadRun(base, 'base'),
    await loadRun(candidate, 'candidate'),
    gateSchema.parse(gate),
  );
}

const codes = (comparison: Comparison) =>
  comparison.gate!.failures.map((failure) => failure.code).sort();

test('every result records the run identity, redacted, without keys or guessed builds', async () => {
  const env = { APP_TOKEN: PLANTED };
  const identity = modelIdentity({
    plannerURL: `https://user:${PLANTED}@gateway.example/v1/chat/completions?key=${PLANTED}#x`,
    plannerKey: PLANTED,
    plannerModel: 'planner-model',
    selectorURL: 'https://api.typesafe.example/v1/systemone',
    selectorKey: PLANTED,
    selectorModel: 'jev-latest',
    plannerHeaders: { 'X-Gateway-Token': PLANTED },
  });
  assert.deepEqual(identity, {
    planner: {
      protocol: 'chat',
      endpoint: 'https://gateway.example/v1/chat/completions',
      model: 'planner-model',
    },
    selector: {
      protocol: 'typesafe',
      endpoint: 'https://api.typesafe.example/v1/systemone',
      model: 'jev-latest',
    },
  });
  const { directory, results } = await run(
    {},
    {
      suite: suiteSchema.parse({ ...fixtureSuite(), name: `Suite ${PLANTED}` }),
      build: `rev-${PLANTED}`,
      modelIdentity: identity,
      env,
    },
  );
  const recorded = runIdentitySchema.parse(results[0]!.identity);
  assert.equal(recorded.engine.version, ENGINE_VERSION);
  assert.equal(recorded.engine.resultVersion, 4);
  assert.equal(recorded.environment.driver, 'fake');
  assert.equal(recorded.environment.browser?.version, '140.0.0.0');
  assert.equal(recorded.suite.target, 'https://app.example');
  assert.deepEqual(recorded.suite.selection, {
    journeys: ['finish'],
    viewports: ['desktop'],
    repeat: 1,
  });
  assert.deepEqual(recorded.models, identity);
  assert.match(recorded.build!.id, /^rev-\[REDACTED:env:APP_TOKEN\]$/);
  for (const name of [
    'results.json',
    'finish-desktop/result.json',
    'events.jsonl',
  ])
    assert.ok(
      !(await readFile(join(directory, name), 'utf8')).includes(PLANTED),
      `${name} holds the planted secret`,
    );
  // A library caller without build or models records them as unknown.
  const [plain] = await runSuite(fixtureSuite(), models, {
    directory: join(root, 'plain'),
    driver: fakeDriver({}),
  });
  assert.equal(plain!.identity!.build, null);
  assert.equal(plain!.identity!.models, null);
  // Builds come only from --build or UIUX_BUILD.
  assert.deepEqual(buildFrom('abc123', { UIUX_BUILD: 'x' }), {
    id: 'abc123',
    source: 'cli',
  });
  assert.deepEqual(buildFrom(undefined, { UIUX_BUILD: 'deploy-7' }), {
    id: 'deploy-7',
    source: 'env',
  });
  assert.equal(buildFrom(undefined, {}), null);
  assert.throws(() => buildFrom('two words', {}), /one token/);
});

test('the suite hash ignores the deployment, retention and secret values, not the configuration', () => {
  const redactor = (value: string) =>
    new Redactor({ env: { APP_PASSWORD: value }, envNames: ['APP_PASSWORD'] });
  const base = fixtureSuite();
  const hash = suiteHash(base, redactor(PLANTED));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(
    suiteHash(
      fixtureSuite({ baseURL: 'https://preview-1f2e.example' }),
      redactor(PLANTED),
    ),
    hash,
  );
  assert.equal(
    suiteHash(
      suiteSchema.parse({ ...base, evidence: { retentionDays: 3 } }),
      redactor(PLANTED),
    ),
    hash,
  );
  assert.notEqual(
    suiteHash(fixtureSuite({ goal: 'Finish now' }), redactor(PLANTED)),
    hash,
  );
  // A secret typed by the journey: rotating its value keeps the identity.
  const withSecret = (value: string) =>
    suiteSchema.parse({
      ...base,
      journeys: [{ ...base.journeys[0]!, goal: `Sign in with ${value}` }],
    });
  assert.equal(
    suiteHash(withSecret(PLANTED), redactor(PLANTED)),
    suiteHash(
      withSecret('rotated-secret-value-2'),
      redactor('rotated-secret-value-2'),
    ),
  );
});

test('finding identities ignore steps, evidence paths, markers, URL origins and measurements', async () => {
  const { results } = await run({ overflow: 40 });
  const result = results[0]!;
  const [instance] = findingInstances(result);
  assert.ok(instance);
  assert.equal(
    instance.gateKey,
    'layout.horizontal-overflow/document-wider-than-viewport',
  );
  assert.equal(instance.path, '/done');
  const moved = structuredClone(result);
  moved.marker = 'UIUX-FINISH-1-XYZ';
  const finding = moved.audits.findings[0]!;
  finding.reproduction.step = 9;
  finding.reproduction.url = 'https://preview.example/done?session=other';
  finding.evidence.screenshot = '/elsewhere/final.png';
  finding.description = 'The document is 999px wider than the viewport';
  finding.targets = [
    { ...finding.targets[0]!, description: 'document 1200px' },
  ];
  assert.equal(findingInstances(moved)[0]!.id, instance.id);
  // A different element is a different finding.
  finding.targets = [{ ...finding.targets[0]!, selector: 'main' }];
  assert.notEqual(findingInstances(moved)[0]!.id, instance.id);
  // Repeating the same scenario yields the same identities.
  const again = (await run({ overflow: 40 })).results[0]!;
  assert.deepEqual(
    findingInstances(again).map((entry) => entry.id),
    findingInstances(result).map((entry) => entry.id),
  );
});

test('a seeded regression fails the gate although the journey still passes', async () => {
  const base = await run({});
  const candidate = await run({ overflow: 60 });
  assert.equal(candidate.results[0]!.status, 'passed');
  const comparison = await compare(base.directory, candidate.directory);
  comparisonSchema.parse(comparison);
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.counts.new, 1);
  assert.equal(comparison.findings.new[0]!.gating, true);
  assert.equal(comparison.gate!.passed, false);
  assert.deepEqual(codes(comparison), ['new_finding']);
  assert.equal(comparison.gate!.config.failOn, 'serious');
  // A rule can exempt it; a higher threshold lets it through.
  assert.equal(
    (
      await compare(base.directory, candidate.directory, {
        rules: [{ id: 'layout.horizontal-overflow/*', gate: 'never' }],
      })
    ).gate!.passed,
    true,
  );
  assert.equal(
    (await compare(base.directory, candidate.directory, { failOn: 'critical' }))
      .gate!.passed,
    true,
  );
});

test('unchanged known findings persist and are not new; fixed ones are resolved', async () => {
  const before = await run({ overflow: 60 });
  const same = await run({ overflow: 60 });
  const persisting = await compare(before.directory, same.directory);
  assert.equal(persisting.counts.new, 0);
  assert.equal(persisting.counts.persisting, 1);
  assert.equal(persisting.gate!.passed, true);
  // Known debt gates only when asked to.
  const strict = await compare(before.directory, same.directory, {
    persisting: true,
  });
  assert.deepEqual(codes(strict), ['persisting_finding']);
  const fixed = await run({});
  const resolved = await compare(before.directory, fixed.directory);
  assert.equal(resolved.counts.resolved, 1);
  assert.equal(resolved.counts.unassessed, 0);
  assert.equal(resolved.gate!.passed, true);
});

test('errored, incomplete and unreached candidate checks leave base findings unassessed, never resolved', async () => {
  const before = await run({ overflow: 60 });
  for (const [status, reason] of [
    ['error', 'error'],
    ['incomplete', 'incomplete'],
    ['unsupported', 'unsupported'],
  ] as const) {
    const after = await run({});
    await edit(after.directory, (results) => {
      for (const auditRun of results[0]!.audits.runs) auditRun.status = status;
    });
    const comparison = await compare(before.directory, after.directory);
    assert.equal(comparison.counts.resolved, 0, status);
    assert.equal(comparison.counts.unassessed, 1, status);
    assert.equal(comparison.findings.unassessed[0]!.reason, reason);
    assert.equal(comparison.counts.coverageLost, 1);
    assert.deepEqual(codes(comparison), [
      'coverage_lost',
      'unassessed_finding',
    ]);
    // report: listed, not gating; still not resolved.
    const reported = await compare(before.directory, after.directory, {
      unassessed: 'report',
    });
    assert.equal(reported.gate!.passed, true);
    assert.equal(reported.counts.resolved, 0);
  }
  const unreached = await run({});
  await edit(unreached.directory, (results) => {
    const audits = results[0]!.audits;
    audits.notReached = audits.runs.map((auditRun) => ({
      auditId: auditRun.auditId,
      at: auditRun.checkpoint.id,
    }));
    audits.runs = [];
  });
  const comparison = await compare(before.directory, unreached.directory);
  assert.equal(comparison.findings.unassessed[0]!.reason, 'not_reached');
  // Coverage the base never had is listed but does not gate.
  const blind = await run({});
  await edit(blind.directory, (results) => {
    for (const auditRun of results[0]!.audits.runs) auditRun.status = 'error';
  });
  const neither = await compare(blind.directory, unreached.directory);
  assert.equal(neither.counts.coverageLost, 0);
  assert.equal(neither.gate!.passed, true);
  // A clean base check the candidate could not assess loses coverage, so a
  // missing check never passes as "no regression".
  const clean = await run({});
  const lost = await compare(clean.directory, unreached.directory);
  assert.deepEqual(codes(lost), ['coverage_lost']);
});

test('a finding measured on a page the candidate did not reach is unassessed', async () => {
  const before = await run({ overflow: 60 });
  const after = await run({});
  await edit(after.directory, (results) => {
    for (const auditRun of results[0]!.audits.runs)
      auditRun.checkpoint.url = 'https://app.example/elsewhere';
  });
  const comparison = await compare(before.directory, after.directory);
  assert.equal(comparison.findings.unassessed[0]!.reason, 'path_not_assessed');
  assert.equal(comparison.counts.resolved, 0);
});

test('hypotheses, needs-review items and runner findings do not gate by default', async () => {
  const before = await run({});
  const after = await run({});
  await edit(after.directory, (results) => {
    const result = results[0]!;
    result.findings.push(
      {
        kind: 'hypothesis',
        category: 'usability',
        description: 'The button label is vague. User impact: hesitation',
        step: 1,
        screenshot: 'x.png',
      },
      {
        kind: 'observed',
        category: 'detour',
        description: 'Reached /preview/3: a preview page',
        step: 2,
        screenshot: 'y.png',
      },
    );
    const auditRun = result.audits.runs[0]!;
    result.audits.findings.push({
      auditId: auditRun.auditId,
      source: auditRun.source,
      analyzer: null,
      ruleId: 'undecided-contrast',
      severity: 'serious',
      certainty: 'needs_review',
      description: 'Contrast could not be decided',
      helpUrl: null,
      tags: [],
      nodeCount: 1,
      targets: [
        { description: 'heading', selector: 'h1', reason: null, snippet: null },
      ],
      run: 0,
      checkpoints: [auditRun.checkpoint.id],
      gating: false,
      evidence: { screenshot: null, files: [] },
      reproduction: {
        journey: result.journey,
        viewport: { name: 'desktop', width: 800, height: 600 },
        checkpoint: auditRun.checkpoint.id,
        step: auditRun.checkpoint.step,
        url: auditRun.checkpoint.url,
      },
    });
  });
  const comparison = await compare(before.directory, after.directory);
  assert.equal(comparison.counts.new, 3);
  assert.ok(comparison.findings.new.every((entry) => !entry.gating));
  assert.equal(comparison.gate!.passed, true);
  assert.deepEqual(
    codes(
      await compare(before.directory, after.directory, { hypotheses: true }),
    ),
    ['new_finding'],
  );
  assert.deepEqual(
    codes(
      await compare(before.directory, after.directory, { needsReview: true }),
    ),
    ['new_finding'],
  );
  assert.deepEqual(
    codes(
      await compare(before.directory, after.directory, {
        observed: true,
        rules: [{ id: 'finding/detour', gate: 'always' }],
      }),
    ),
    ['new_finding'],
  );
  // needs_review becoming a violation is an escalation of a known finding.
  const escalated = await run({});
  const later = structuredClone(
    parseResults(await readFile(join(after.directory, 'results.json'), 'utf8')),
  );
  later[0]!.audits.findings.at(-1)!.certainty = 'violation';
  await writeFile(
    join(escalated.directory, 'results.json'),
    JSON.stringify(later),
  );
  assert.deepEqual(codes(await compare(after.directory, escalated.directory)), [
    'escalated_finding',
  ]);
});

test('a functional regression fails the gate; a missing journey is not an improvement', async () => {
  const before = await run({});
  const after = await run({ fails: true });
  const comparison = await compare(before.directory, after.directory);
  assert.equal(comparison.outcomes[0]!.regression, true);
  assert.deepEqual(codes(comparison), ['outcome_regression']);
  assert.equal(
    (await compare(before.directory, after.directory, { outcomes: 'ignore' }))
      .gate!.passed,
    true,
  );
  const withFinding = await run({ overflow: 60 });
  const empty = await run({});
  await edit(empty.directory, (results) => {
    results[0]!.journey = 'other';
  });
  const missing = await compare(withFinding.directory, empty.directory);
  assert.equal(missing.findings.unassessed[0]!.reason, 'run_missing');
  assert.ok(codes(missing).includes('run_missing'));
  assert.equal(missing.counts.resolved, 0);
});

test('incompatible runs are not compared, and the comparison says why', async () => {
  const before = await run({});
  const otherSuite = await run(
    {},
    { suite: fixtureSuite({ goal: 'Something else' }) },
  );
  const otherBrowser = await run({ browserVersion: '141.0.0.0' });
  const otherModels = await run(
    {},
    {
      modelIdentity: modelIdentity({
        plannerURL: 'https://gateway.example/v1',
        plannerKey: 'k',
        plannerModel: 'other',
        selectorURL: 'https://gateway.example/v1',
        selectorKey: 'k',
        selectorModel: 'other',
        selectorProtocol: 'chat',
      }),
    },
  );
  for (const [candidate, field] of [
    [otherSuite.directory, 'suite.hash'],
    [otherBrowser.directory, 'environment.browser.version'],
    [otherModels.directory, 'models'],
  ] as const) {
    const comparison = await compare(before.directory, candidate);
    comparisonSchema.parse(comparison);
    assert.equal(comparison.compatible, false);
    assert.deepEqual(
      comparison.incompatibilities.map((entry) => entry.field),
      [field],
    );
    assert.equal(comparison.gate, null);
    assert.equal(comparison.counts.new + comparison.counts.resolved, 0);
  }
  const anonymous = await run({});
  await edit(anonymous.directory, (results) => {
    delete results[0]!.identity;
  });
  assert.deepEqual(
    (
      await compare(before.directory, anonymous.directory)
    ).incompatibilities.map((entry) => entry.field),
    ['identity'],
  );
  // Another engine version blocks the comparison (not a warning): a newer
  // engine can measure the same UI differently.
  const newer = await run({});
  await edit(newer.directory, (results) => {
    results[0]!.identity!.engine.version = '9.9.9';
  });
  const engine = await compare(before.directory, newer.directory);
  assert.equal(engine.compatible, false);
  assert.deepEqual(
    engine.incompatibilities.map((entry) => entry.field),
    ['engine.version'],
  );
  assert.equal(engine.gate, null);
  const old = await run({});
  const file = join(old.directory, 'results.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw[0].resultVersion = 3;
  await writeFile(file, JSON.stringify(raw));
  assert.deepEqual(
    (await compare(old.directory, before.directory)).incompatibilities.map(
      (entry) => entry.field,
    ),
    ['engine.resultVersion'],
  );
});

test('gate files are validated', () => {
  assert.equal(gateSchema.safeParse({ failOn: 'loud' }).success, false);
  assert.equal(gateSchema.safeParse({ unknown: true }).success, false);
  assert.equal(
    gateSchema.safeParse({ rules: [{ id: 'nope.audit/rule', gate: 'never' }] })
      .success,
    false,
  );
  assert.equal(
    gateSchema.safeParse({
      rules: [
        {
          id: 'accessibility.axe/color-contrast',
          gate: 'never',
          failOn: 'minor',
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    gateSchema.safeParse({
      rules: [{ id: 'accessibility.axe/*', failOn: 'critical' }],
    }).success,
    true,
  );
});

const cli = (args: string[], env: Record<string, string> = {}) =>
  exec(process.execPath, ['--import', 'tsx', 'src/compare-cli.ts', ...args], {
    env: { ...process.env, ...env },
  }).then(
    (output) => ({ code: 0, ...output }),
    (error: { code: number; stdout: string; stderr: string }) => ({
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    }),
  );

test('npm run compare: exit codes, files and no secret values in its output', async () => {
  const base = await run({});
  const regressed = await run({ overflow: 60 });
  // A secret that reached a results file unredacted (an older run, a custom
  // driver) is still redacted from the comparison.
  await edit(regressed.directory, (results) => {
    results[0]!.audits.findings[0]!.targets[0]!.description = `token ${PLANTED}`;
    results[0]!.audits.findings[0]!.description = `seen with ${PLANTED}`;
  });
  const failed = await cli([base.directory, regressed.directory], {
    APP_SECRET: PLANTED,
  });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stdout, /GATE FAILED/);
  const [out] = (await readdir(regressed.directory)).filter((name) =>
    name.startsWith('comparison-'),
  );
  assert.ok(out);
  for (const name of ['comparison.json', 'comparison.html']) {
    const text = await readFile(join(regressed.directory, out, name), 'utf8');
    assert.ok(!text.includes(PLANTED), `${name} holds the planted secret`);
    assert.ok(text.includes('[REDACTED:env:APP_SECRET]'), name);
  }
  assert.ok(!failed.stdout.includes(PLANTED));
  comparisonSchema.parse(
    JSON.parse(
      await readFile(join(regressed.directory, out, 'comparison.json'), 'utf8'),
    ),
  );
  const same = await run({});
  const passed = await cli([
    base.directory,
    same.directory,
    '--out',
    join(root, 'cmp-pass'),
  ]);
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stdout, /GATE PASSED/);
  // The output directory must be new.
  assert.equal(
    (
      await cli([
        base.directory,
        same.directory,
        '--out',
        join(root, 'cmp-pass'),
      ])
    ).code,
    2,
  );
  const other = await run({}, { suite: fixtureSuite({ goal: 'Elsewhere' }) });
  const invalid = await cli([
    base.directory,
    other.directory,
    '--out',
    join(root, 'cmp-invalid'),
  ]);
  assert.equal(invalid.code, 3);
  assert.match(invalid.stdout, /COMPARISON INVALID[\s\S]*suite\.hash/);
  const gate = join(root, 'gate.json');
  await writeFile(gate, JSON.stringify({ failOn: 'loud' }));
  const badGate = await cli([base.directory, same.directory, '--gate', gate]);
  assert.equal(badGate.code, 2);
  assert.match(badGate.stderr, /Invalid gate/);
  assert.equal((await cli([base.directory])).code, 2);
  assert.equal((await cli([base.directory, base.directory])).code, 2);
  assert.equal((await cli([base.directory, join(root, 'missing')])).code, 2);
  const lenient = join(root, 'lenient.json');
  await writeFile(
    lenient,
    JSON.stringify({
      rules: [{ id: 'layout.horizontal-overflow/*', gate: 'never' }],
    }),
  );
  await mkdir(join(root, 'cmp-lenient-parent'));
  const allowed = await cli([
    base.directory,
    regressed.directory,
    '--gate',
    lenient,
    '--out',
    join(root, 'cmp-lenient-parent', 'out'),
  ]);
  assert.equal(allowed.code, 0, allowed.stderr);
});

test("writeComparison redacts the suites' declared patterns from both runs", async () => {
  const suite = suiteSchema.parse({
    ...fixtureSuite(),
    evidence: { redact: [{ pattern: 'CASE-\\d{6}', label: 'case' }] },
  });
  const base = await run({}, { suite });
  const candidate = await run({ overflow: 60 }, { suite });
  await edit(candidate.directory, (results) => {
    results[0]!.audits.findings[0]!.description =
      'Found CASE-123456 on the page';
  });
  const files = await writeComparison({
    base: base.directory,
    candidate: candidate.directory,
    gate: gateSchema.parse({}),
    out: join(root, 'cmp-patterns'),
    env: {},
  });
  const json = await readFile(files.json, 'utf8');
  assert.ok(!json.includes('CASE-123456'));
  assert.ok(json.includes('[REDACTED:case]'));
});

test('npm run run -- --compare checks the gate, the base and the build before any run starts', async () => {
  const suiteFile = join(root, 'suite.json');
  await writeFile(suiteFile, JSON.stringify(fixtureSuite()));
  const base = await run({});
  const badGate = join(root, 'bad-gate.json');
  await writeFile(badGate, JSON.stringify({ outcomes: 'sometimes' }));
  const runCli = (args: string[]) =>
    exec(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--suite', suiteFile, ...args],
      {
        // No model credentials: any of these reaching a run would fail on
        // them instead of on the checked input.
        env: { PATH: process.env.PATH ?? '' },
      },
    ).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => ({
        code: error.code,
        stderr: error.stderr,
      }),
    );
  const gateOnly = await runCli(['--gate', badGate]);
  assert.equal(gateOnly.code, 2);
  assert.match(gateOnly.stderr, /--gate requires --compare/);
  const invalid = await runCli([
    '--compare',
    base.directory,
    '--gate',
    badGate,
  ]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Invalid gate .*outcomes/);
  const missing = await runCli(['--compare', join(root, 'no-such-run')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /base run .* does not exist/);
  const build = await runCli(['--build', 'two words']);
  assert.equal(build.code, 2);
  assert.match(build.stderr, /--build must be one token/);
});
