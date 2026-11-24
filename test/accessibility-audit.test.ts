import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { axeAuditOutput } from '../src/audits/accessibility.js';
import { DEFAULT_AXE_TAGS } from '../src/audits/config.js';
import { auditOutputSchema } from '../src/audits/contract.js';
import { JourneyAudits } from '../src/audits/run.js';
import {
  suiteSchema,
  type Action,
  type Choice,
  type Journey,
  type Observation,
} from '../src/contracts.js';
import { chromium } from 'playwright';
import { PLAYWRIGHT_AUDITS } from '../src/drivers/playwright-audits.js';
import type { DriverAuditRequest, UISession } from '../src/drivers/types.js';
import type { Models } from '../src/models.js';
import type { Result } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import {
  accessibilityFixtures,
  contrastNeedsReview,
} from './fixtures/accessibility.js';

// Each fixture page links to /done; the journey ends there, so the ready
// checkpoint scans "/" and the completion checkpoint scans "/done".
const withFinish = (html: string) =>
  html.replace('</main>', '<p><a href="/done">Finish</a></p></main>');

async function site(pages: { start: string; done: string }) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      request.url === '/done' ? pages.done : withFinish(pages.start),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const journey: Journey = {
  id: 'finish',
  goal: 'Finish the task',
  persona: 'A first-time visitor',
  startPath: '/',
  allowedPaths: ['/', '/done'],
  ready: { kind: 'path', pattern: '^/$' },
  success: [{ kind: 'path', pattern: '^/done$' }],
  interactions: [],
  discoverRoles: [],
  maxSteps: 4,
  maxDurationMs: 30000,
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
// Fixed decisions, no model calls: open the Finish link.
const deterministic: Models = {
  async plan() {
    return { objective: 'Open the Finish link', concerns: [] };
  },
  async choose(_journey, _observation, _plan, actions) {
    return selected(
      actions.find(
        (action) => action.kind === 'link' && action.description.includes('Finish'),
      )?.id ?? 'no_match',
      actions,
    );
  },
};

async function run(
  pages: { start: string; done: string },
  audits: unknown,
): Promise<Result> {
  const app = await site(pages);
  try {
    const parent = await mkdtemp(join(tmpdir(), 'ui-ux-axe-journey-'));
    const results = await runSuite(
      suiteSchema.parse({
        name: 'LOCAL fixture — accessibility audit',
        baseURL: app.url,
        requiresAuth: false,
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        journeys: [journey],
        audits,
      }),
      deterministic,
      { directory: join(parent, 'run') },
    );
    assert.equal(results.length, 1);
    return results[0]!;
  } finally {
    await app.close();
  }
}

const axeRuns = (result: Result) =>
  result.audits.runs.filter((entry) => entry.auditId === 'accessibility.axe');
const axeFindings = (result: Result) =>
  result.audits.findings.filter(
    (finding) => finding.auditId === 'accessibility.axe',
  );
const axeCheck = (result: Result) =>
  result.quality.executed.find((check) => check.id === 'accessibility.axe');

test('a broken page produces gating axe findings at its checkpoints through a real journey', async () => {
  const fixture = accessibilityFixtures.formLabels;
  const result = await run(
    { start: fixture.broken, done: fixture.fixed },
    { checks: [{ id: 'accessibility.axe' }] },
  );
  // The functional outcome is independent of the audit.
  assert.equal(result.status, 'passed');
  const runs = axeRuns(result);
  assert.deepEqual(
    runs.map((entry) => [entry.checkpoint.id, entry.status]),
    [
      ['ready', 'findings'],
      ['completion', 'clean'],
    ],
  );
  assert.equal(runs[0]!.source, 'axe-core');
  assert.equal(runs[0]!.analyzer?.name, 'axe-core');
  assert.match(runs[0]!.analyzer?.version ?? '', /^\d+\.\d+\.\d+/);
  assert.match(runs[0]!.limitations.join(' '), /does not establish WCAG conformance/);
  assert.match(runs[1]!.checkpoint.url ?? '', /\/done$/);
  const findings = axeFindings(result);
  assert.deepEqual(
    findings.map((finding) => finding.ruleId).sort(),
    ['label', 'select-name'],
  );
  for (const finding of findings) {
    assert.equal(finding.certainty, 'violation');
    assert.equal(finding.severity, 'critical');
    assert.equal(finding.gating, true);
    assert.equal(finding.reproduction.checkpoint, 'ready');
    assert.ok(finding.tags.includes('wcag2a'));
    assert.match(finding.helpUrl ?? '', /^https:\/\/dequeuniversity\.com\//);
    assert.ok(finding.targets[0]!.selector);
    assert.ok((finding.targets[0]!.snippet ?? '').length <= 300);
    assert.ok(finding.evidence.screenshot);
  }
  assert.equal(axeCheck(result)?.status, 'failed');
  assert.equal(result.quality.verdict, 'fail');
  // The configured scan is its own audit check; the not-configured gap goes.
  assert.ok(
    !result.quality.unsupported.some((gap) => gap.id === 'accessibility.audit'),
  );
});

test('needs-review results are listed but never gate the verdict', async () => {
  const result = await run(
    { start: contrastNeedsReview, done: contrastNeedsReview },
    { checks: [{ id: 'accessibility.axe', at: ['completion'] }] },
  );
  const [only] = axeRuns(result);
  assert.equal(only?.status, 'clean');
  const findings = axeFindings(result);
  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.certainty, finding.gating]),
    [['color-contrast', 'needs_review', false]],
  );
  const [target] = findings[0]!.targets;
  // The element is named; axe's explanation is the reason.
  assert.equal(target!.description, 'p element');
  assert.match(target!.reason ?? '', /background/i);
  assert.equal(axeCheck(result)?.status, 'passed');
  assert.equal(result.quality.verdict, 'pass');
});

test('failOn none reports violations without failing quality', async () => {
  const fixture = accessibilityFixtures.semantics;
  const result = await run(
    { start: fixture.broken, done: fixture.broken },
    { checks: [{ id: 'accessibility.axe', at: ['ready'] }], failOn: 'none' },
  );
  assert.equal(axeRuns(result)[0]?.status, 'findings');
  assert.ok(axeFindings(result).length >= 4);
  assert.ok(axeFindings(result).every((finding) => !finding.gating));
  assert.equal(axeCheck(result)?.status, 'passed');
});

test('a scope selector that matches nothing is an error run, not clean', async () => {
  const fixture = accessibilityFixtures.accessibleNames;
  const result = await run(
    { start: fixture.fixed, done: fixture.fixed },
    {
      checks: [
        { id: 'accessibility.axe', at: ['completion'], include: ['#checkout'] },
      ],
    },
  );
  const [only] = axeRuns(result);
  assert.equal(only?.status, 'error');
  assert.match(only?.detail ?? '', /scope_not_found/);
  assert.match(only?.detail ?? '', /#checkout/);
  assert.equal(only?.observations, 0);
  assert.equal(axeCheck(result)?.status, 'errored');
  assert.equal(result.quality.verdict, 'not_evaluated');
});

test('the axe audit config parses with WCAG A/AA and best-practice defaults', () => {
  const parse = (audits: unknown) =>
    suiteSchema.safeParse({
      name: 'config',
      baseURL: 'https://fixture.example',
      requiresAuth: false,
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      journeys: [journey],
      audits,
    });
  const parsed = parse({ checks: [{ id: 'accessibility.axe' }] });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.audits.checks![0], {
    id: 'accessibility.axe',
    at: ['ready', 'completion'],
    include: [],
    exclude: [],
    tags: DEFAULT_AXE_TAGS,
  });
  assert.ok(
    parse({
      checks: [
        {
          id: 'accessibility.axe',
          tags: ['wcag2a', 'cat.forms'],
          exclude: ['#chat'],
          timeoutMs: 60000,
        },
      ],
    }).success,
  );
  for (const bad of [
    { id: 'accessibility.axe', tags: [] },
    { id: 'accessibility.axe', tags: ['wcag2a; alert(1)'] },
    { id: 'accessibility.axe', include: [''] },
    { id: 'accessibility.axe', timeoutMs: 500 },
    { id: 'accessibility.axe', timeoutMs: 200000 },
  ])
    assert.equal(parse({ checks: [bad] }).success, false, JSON.stringify(bad));
});

test('the axe audit is unsupported on the macOS driver, never run or clean', async () => {
  const suite = suiteSchema.parse({
    name: 'config',
    baseURL: 'https://fixture.example',
    requiresAuth: false,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [journey],
    audits: { checks: [{ id: 'accessibility.axe', at: ['ready'] }] },
  });
  let called = false;
  const session = {
    driver: 'macos',
    async runAudit() {
      called = true;
      return {};
    },
  } as unknown as UISession;
  const audits = new JourneyAudits({
    suite,
    journey,
    viewport: { name: 'desktop', width: 1280, height: 800 },
    directory: tmpdir(),
    session,
    log: async () => {},
  });
  const state = {
    step: 0,
    url: 'https://fixture.example/',
    snapshot: '',
    screenshot: 'step.png',
    visibleViewport: { width: 1280, height: 800 },
    fingerprint: 'f',
    scroll: { x: 0, y: 0, containers: [] },
    horizontalOverflow: 0,
  } as unknown as Observation;
  audits.record(state);
  await audits.afterObservation(state);
  const [only] = audits.finish().runs;
  assert.equal(only?.status, 'unsupported');
  assert.match(only?.detail ?? '', /macOS/);
  assert.equal(called, false);
});

test('scan results map onto the audit contract; a failed scan throws with its kind', () => {
  const context = { scope: { include: ['#main'], exclude: [] }, tags: ['wcag2a'], durationMs: 3 };
  const output = auditOutputSchema.parse(
    axeAuditOutput({
      status: 'completed',
      analyzer: { name: 'axe-core', version: '4.14.0' },
      url: 'https://fixture.example/',
      scope: context.scope,
      tags: context.tags,
      violations: [
        {
          ruleId: 'button-name',
          impact: null,
          help: 'Buttons must have discernible text',
          description: 'Ensure buttons have discernible text',
          helpUrl: 'javascript:alert(1)',
          wcag: ['wcag2a'],
          tags: ['wcag2a'],
          nodeCount: 3,
          nodes: [
            {
              target: ['iframe#pay', 'my-widget >> button'],
              html: '<button></button>',
              htmlTruncated: false,
              impact: null,
              messages: [],
            },
          ],
          nodesTruncated: true,
        },
      ],
      incomplete: [],
      passedRules: 4,
      inapplicableRules: 2,
      durationMs: 3,
      limitations: ['partial'],
    }),
  );
  const [finding] = output.findings;
  assert.equal(finding!.certainty, 'violation');
  assert.equal(finding!.severity, null);
  // Only http(s) guidance links are kept.
  assert.equal(finding!.helpUrl, null);
  assert.equal(finding!.nodeCount, 3);
  assert.deepEqual(finding!.targets[0], {
    description: 'button element',
    selector: 'iframe#pay >>> my-widget >> button',
    reason: null,
    snippet: '<button></button>',
  });
  assert.deepEqual(output.exemptions, []);
  assert.ok(output.limitations.some((text) => text.includes('#main')));
  assert.throws(
    () =>
      axeAuditOutput({
        status: 'error',
        analyzer: { name: 'axe-core', version: null },
        url: 'https://fixture.example/',
        scope: context.scope,
        tags: context.tags,
        error: { kind: 'timeout', message: 'did not\nfinish' },
        durationMs: 3,
        limitations: [],
      }),
    /^Error: axe-core scan error \(timeout\): did not finish$/,
  );
});

test('the accessibility example suite parses', async () => {
  const suite = suiteSchema.parse(
    JSON.parse(await readFile('examples/website-accessibility.json', 'utf8')),
  );
  const axe = suite.audits.checks!.find((check) => check.id === 'accessibility.axe');
  assert.deepEqual(axe?.at, ['ready', 'states', 'completion']);
  assert.equal(suite.journeys[0]!.states?.[0]?.name, 'docs-index');
});

test('a per-check timeoutMs overrides audits.timeoutMs for the scan', async () => {
  const suite = suiteSchema.parse({
    name: 'config',
    baseURL: 'https://fixture.example',
    requiresAuth: false,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [journey],
    audits: {
      timeoutMs: 20000,
      checks: [
        { id: 'accessibility.axe', at: ['ready'], timeoutMs: 4000 },
        { id: 'layout.horizontal-overflow', at: ['ready'] },
      ],
    },
  });
  const requested: number[] = [];
  const session = {
    driver: 'playwright',
    async runAudit(request: DriverAuditRequest) {
      requested.push(request.timeoutMs);
      return { complete: true, findings: [] };
    },
  } as unknown as UISession;
  const audits = new JourneyAudits({
    suite,
    journey,
    viewport: { name: 'desktop', width: 1280, height: 800 },
    directory: tmpdir(),
    session,
    log: async () => {},
  });
  const state = {
    step: 0,
    url: 'https://fixture.example/',
    screenshot: 'step.png',
    horizontalOverflow: 0,
  } as unknown as Observation;
  audits.record(state);
  await audits.afterObservation(state);
  assert.deepEqual(requested, [4000]);

  // The scan keeps 250 ms back for its own timeout error, which names the
  // kind; a 251 ms budget leaves the scan 1 ms.
  const app = await site({
    start: accessibilityFixtures.semantics.broken,
    done: accessibilityFixtures.semantics.broken,
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(app.url);
    const config = suite.audits.checks![0]!;
    await assert.rejects(
      PLAYWRIGHT_AUDITS['accessibility.axe']!(page, {
        config,
        checkpoint: {
          id: 'ready',
          kind: 'ready',
          name: null,
          step: 0,
          url: app.url,
          screenshot: null,
        },
        viewport: { name: 'desktop', width: 1280, height: 800 },
        directory: tmpdir(),
        scope: { suite: 'accessibility', journey: 'scan' },
        baselines: null,
        timeoutMs: 251,
      }),
      /axe-core scan error \(timeout\): Accessibility scan did not finish within 1 ms/,
    );
  } finally {
    await browser.close();
    await app.close();
  }
});

test('without the axe scan the accessibility gap says how to enable it', async () => {
  const result = await run(
    {
      start: accessibilityFixtures.formLabels.broken,
      done: accessibilityFixtures.formLabels.broken,
    },
    { checks: [{ id: 'layout.horizontal-overflow' }] },
  );
  assert.deepEqual(axeRuns(result), []);
  assert.match(
    result.quality.unsupported.find((gap) => gap.id === 'accessibility.audit')
      ?.reason ?? '',
    /add accessibility\.axe to audits\.checks/,
  );
});

test('a target names its element from the snippet; the selector says where', async () => {
  const result = await run(
    {
      start: accessibilityFixtures.formLabels.broken,
      done: accessibilityFixtures.formLabels.broken,
    },
    { checks: [{ id: 'accessibility.axe', at: ['ready'] }] },
  );
  const targets = Object.fromEntries(
    axeFindings(result).map((finding) => [finding.ruleId, finding.targets[0]!]),
  );
  assert.equal(targets.label!.description, 'input element (name="email")');
  assert.equal(targets.label!.selector, 'input');
  assert.match(targets.label!.reason ?? '', /explicit <label>/);
  assert.equal(targets['select-name']!.description, 'select element (name="plan")');
});
