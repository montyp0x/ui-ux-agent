// The layout.responsive audit on the 1A checkpoint framework: configuration,
// the mapping onto the audit contract, and a real journey whose checkpoint
// sweeps breakpoints in place. No model calls.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { auditConfigSchema } from '../src/audits/config.js';
import { auditOutputSchema } from '../src/audits/contract.js';
import {
  expandBreakpoints,
  layoutAuditResultSchema,
} from '../src/audits/layout.js';
import { layoutAuditOutput } from '../src/audits/layout-output.js';
import { AUDITS } from '../src/audits/registry.js';
import { suiteSchema } from '../src/contracts.js';
import {
  auditLayoutMatrix,
  layoutResponsivePlaywrightAudit,
} from '../src/drivers/playwright-layout.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import {
  clippedLabel,
  iconToolbar,
  intentionalOverlap,
  stickyBanner,
} from './layout-fixtures.js';

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

const mobile = expandBreakpoints({
  breakpoints: [{ name: 'mobile', width: 390, height: 844 }],
  reflow: false,
});

test('layout.responsive is configured per suite with checkpoints, breakpoints and exceptions', () => {
  const parsed = auditConfigSchema.parse({ id: 'layout.responsive' });
  assert.equal(parsed.id, 'layout.responsive');
  if (parsed.id !== 'layout.responsive') return;
  assert.deepEqual(parsed.at, ['ready', 'completion']);
  assert.deepEqual(parsed.rules, ['clipping', 'occlusion', 'target-size']);
  assert.deepEqual(parsed.matrix.reflow, {
    baseWidth: 1280,
    baseHeight: 1024,
    zoom: 4,
  });
  assert.deepEqual(
    expandBreakpoints(parsed.matrix, [], true).map((entry) => entry.name),
    ['reflow-400'],
  );
  // Per-check timeout, shared by every audit entry.
  const timed = auditConfigSchema.parse({
    id: 'layout.responsive',
    timeoutMs: 30000,
  });
  assert.equal(timed.timeoutMs, 30000);
  assert.throws(() =>
    auditConfigSchema.parse({ id: 'layout.responsive', unknown: true }),
  );
  const suite = suiteSchema.parse({
    name: 'layout',
    baseURL: 'https://app.example',
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    audits: {
      checks: [
        {
          id: 'layout.responsive',
          at: ['completion'],
          requiredControls: [
            { by: 'role', role: 'button', name: 'Place order' },
          ],
          matrix: {
            breakpoints: [{ name: 'mobile', width: 390, height: 844 }],
          },
          exceptions: [
            {
              rule: 'clipping',
              selector: '.carousel',
              reason: 'One slide at a time',
              breakpoints: ['mobile'],
            },
          ],
        },
      ],
    },
    journeys: [
      {
        id: 'checkout',
        goal: 'Check out',
        persona: 'A shopper',
        startPath: '/',
        allowedPaths: ['/'],
        ready: {
          kind: 'visible',
          target: { by: 'role', role: 'heading', name: 'Checkout' },
        },
        success: [{ kind: 'path', pattern: '^/$' }],
      },
    ],
  });
  assert.equal(suite.audits.checks[0]!.id, 'layout.responsive');
  // The documented example suite stays valid.
  const example = suiteSchema.parse(
    JSON.parse(readFileSync('examples/responsive-layout.json', 'utf8')),
  );
  assert.deepEqual(
    example.audits.checks.map((check) => check.id),
    ['layout.horizontal-overflow', 'layout.responsive'],
  );
  // A driver audit, unsupported on macOS rather than silently clean.
  assert.deepEqual(AUDITS['layout.responsive'].drivers, ['playwright']);
  assert.equal(AUDITS['layout.responsive'].evaluate, undefined);
});

test('layout results map onto the audit contract with deliberate severities', async () => {
  const banner = await auditLayoutMatrix({
    browser,
    breakpoints: mobile,
    config: {
      requiredControls: [{ by: 'role', role: 'button', name: 'Place order' }],
    },
    open: (page) => page.setContent(stickyBanner.defect),
  });
  const toolbar = await auditLayoutMatrix({
    browser,
    breakpoints: mobile,
    config: {},
    open: (page) => page.setContent(iconToolbar.defect),
  });
  const output = auditOutputSchema.parse(
    layoutAuditOutput([...banner, ...toolbar], {
      session: 'desktop',
      files: ['run/layout-ready-step0.json'],
    }),
  );
  assert.equal(output.complete, true);
  assert.equal(output.observations, 2);
  assert.equal(output.analyzer, null);
  const occluded = output.findings.find(
    (finding) => finding.ruleId === 'occluded-control',
  )!;
  assert.equal(occluded.severity, 'serious');
  assert.equal(occluded.certainty, 'violation');
  assert.match(
    occluded.description,
    /^\[mobile 390x844\] Required control "Place order"/,
  );
  assert.deepEqual(occluded.tags, ['breakpoint:mobile', 'required']);
  assert.deepEqual(
    occluded.targets.map((target) => target.selector),
    ['body > main > form > button', 'body > div'],
  );
  assert.deepEqual(occluded.files, ['run/layout-ready-step0.json']);
  const sizes = output.findings.filter(
    (finding) => finding.ruleId === 'target-size',
  );
  assert.equal(sizes.length, 4);
  assert.ok(sizes.every((finding) => finding.severity === 'moderate'));
  assert.ok(sizes[0]!.tags.includes('wcag258'));
  assert.match(sizes[0]!.helpUrl!, /target-size-minimum/);
  // Built-in WCAG exemptions are not configuration: they are noted in the
  // run's limitations, and configured exemptions stay empty.
  assert.deepEqual(output.exemptions, []);
  assert.ok(
    output.limitations.includes(
      'mobile: 1 target-size exempted by the WCAG 2.5.8 inline exception',
    ),
  );
  assert.ok(
    output.limitations.includes(
      'mobile: 1 target-size exempted by the WCAG 2.5.8 equivalent-label exception',
    ),
  );
});

test('exceptions, unused exceptions and review candidates are visible; errors throw', async () => {
  const [overlap] = await auditLayoutMatrix({
    browser,
    breakpoints: mobile,
    config: {
      exceptions: [
        {
          rule: 'clipping',
          selector: '.carousel',
          reason: 'One slide at a time',
        },
        { rule: 'occlusion', selector: '.stale', reason: 'Old banner' },
      ],
    },
    open: (page) => page.setContent(intentionalOverlap),
  });
  const output = auditOutputSchema.parse(
    layoutAuditOutput([overlap!], { session: 'desktop' }),
  );
  // Configured exemptions are typed, with the measurement they suppressed.
  assert.deepEqual(
    output.exemptions.map((entry) => [
      entry.ruleId,
      entry.target.selector,
      entry.reason,
    ]),
    [
      [
        'clipped-content',
        'body > div:nth-of-type(1)',
        'Exception #0 (.carousel, matched on subject): One slide at a time',
      ],
    ],
  );
  assert.match(output.exemptions[0]!.target.description, /^\[mobile 390x844\]/);
  assert.match(output.exemptions[0]!.target.reason!, /cut off by up to/);
  assert.ok(
    output.limitations.includes(
      'mobile: exception #1 (.stale) matched nothing',
    ),
  );
  // The promo label is clipped text (moderate); the art over the CTA is a
  // non-required occlusion (moderate).
  assert.deepEqual(
    output.findings.map((finding) => [finding.ruleId, finding.severity]),
    [
      ['clipped-content', 'moderate'],
      ['occluded-control', 'moderate'],
      ['target-size', 'moderate'],
      ['target-size', 'moderate'],
      ['target-size', 'moderate'],
    ],
  );
  const [truncated] = await auditLayoutMatrix({
    browser,
    breakpoints: mobile,
    config: { rules: ['clipping'] },
    open: (page) =>
      page.setContent(
        '<p style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long product title that does not fit</p>',
      ),
  });
  const review = auditOutputSchema.parse(
    layoutAuditOutput([truncated!], { session: 'desktop' }),
  );
  assert.deepEqual(
    review.findings.map((finding) => [
      finding.ruleId,
      finding.certainty,
      finding.severity,
    ]),
    [['clipped-content.truncation-ellipsis', 'needs_review', null]],
  );
  // Reflow overflow at an extra breakpoint is reported; the session's own
  // viewport is left to layout.horizontal-overflow.
  const wide = layoutAuditResultSchema.parse({
    ...truncated!,
    breakpoint: {
      ...truncated!.breakpoint!,
      name: 'reflow-400',
      kind: 'reflow',
      zoom: 4,
    },
    horizontalOverflow: 80,
  });
  const reflow = auditOutputSchema.parse(
    layoutAuditOutput([wide], { session: 'mobile' }),
  );
  assert.ok(
    reflow.findings.some(
      (finding) =>
        finding.ruleId === 'document-wider-than-viewport' &&
        finding.severity === 'serious' &&
        finding.tags.includes('wcag1410'),
    ),
  );
  const current = layoutAuditResultSchema.parse({
    ...wide,
    breakpoint: {
      ...wide.breakpoint!,
      name: 'mobile',
      kind: 'viewport',
      zoom: null,
    },
  });
  // Overflow at the session's own viewport is layout.horizontal-overflow's.
  assert.ok(
    !layoutAuditOutput([current], { session: 'mobile' }).findings.some(
      (finding) => finding.ruleId === 'document-wider-than-viewport',
    ),
  );
  // A detector error fails the audit; an unsupported breakpoint makes it incomplete.
  const broken = layoutAuditResultSchema.parse({
    ...truncated!,
    status: 'error',
    detectors: truncated!.detectors.map((detector) => ({
      ...detector,
      status: 'error',
      error: 'Boom',
    })),
  });
  assert.throws(
    () =>
      layoutAuditOutput([truncated!, broken], {
        session: 'desktop',
        files: ['x.json'],
      }),
    /Layout audit failed at mobile: clipping Boom \(measurements: x\.json\)/,
  );
  const unsupported = layoutAuditResultSchema.parse({
    ...truncated!,
    status: 'unsupported',
    detail: 'Device pixel ratio 3 needs a new browser context',
    detectors: [],
  });
  const partial = layoutAuditOutput([truncated!, unsupported], {
    session: 'desktop',
  });
  assert.equal(partial.complete, false);
  assert.match(partial.detail!, /mobile: Device pixel ratio 3/);
});

test('a journey checkpoint sweeps breakpoints in place and the journey continues unchanged', async () => {
  const checkout = stickyBanner.defect.replace(
    '<h1>Checkout</h1>',
    '<h1>Checkout</h1><a href="/done" style="display:inline-block;padding:12px">Continue</a>',
  );
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url === '/done'
        ? '<!doctype html><title>Done</title><h1>Done</h1><p>Thanks for your order.</p>'
        : checkout,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const suite = suiteSchema.parse({
      name: 'responsive',
      baseURL: `http://127.0.0.1:${port}`,
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      audits: {
        checks: [
          {
            id: 'layout.responsive',
            requiredControls: [
              { by: 'role', role: 'button', name: 'Place order' },
            ],
            matrix: {
              breakpoints: [{ name: 'mobile', width: 390, height: 844 }],
            },
          },
        ],
      },
      journeys: [
        {
          id: 'checkout',
          goal: 'Finish checkout',
          persona: 'A shopper',
          startPath: '/',
          allowedPaths: ['/', '/done'],
          ready: {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Checkout' },
          },
          success: [{ kind: 'path', pattern: '^/done$' }],
          maxSteps: 3,
          maxDurationMs: 30000,
        },
      ],
    });
    const models: Models = {
      async plan() {
        return { objective: 'Continue', concerns: [] };
      },
      async choose(_journey, observation, _plan, actions) {
        // The planner sees the desktop layout again after the sweep.
        assert.equal(observation.visibleViewport.width, 1280);
        return {
          type: 'choice',
          choice:
            actions.find((action) => action.kind === 'link')?.id ?? 'no_match',
          confidence: 1,
          probabilities: {},
        };
      },
    };
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-layout-')),
      'run',
    );
    const [result] = await runSuite(suite, models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    assert.deepEqual(
      result!.audits.runs.map((run) => [
        run.auditId,
        run.checkpoint.id,
        run.status,
      ]),
      [
        ['layout.responsive', 'ready', 'findings'],
        // The confirmation page has no Place order button: the required
        // control is missing, so that run is incomplete rather than clean.
        ['layout.responsive', 'completion', 'incomplete'],
      ],
    );
    assert.match(
      result!.audits.runs[1]!.detail!,
      /Required control #0 \(button "Place order"\) was not found/,
    );
    const findings = result!.audits.findings;
    // The desktop session is clean; mobile and the 400% reflow case are not.
    assert.deepEqual(
      [
        ...new Set(
          findings.map((finding) =>
            finding.tags.find((tag) => tag.startsWith('breakpoint:')),
          ),
        ),
      ],
      ['breakpoint:mobile', 'breakpoint:reflow-400'],
    );
    const occluded = findings.find(
      (finding) => finding.ruleId === 'occluded-control',
    )!;
    assert.equal(occluded.gating, true);
    assert.equal(occluded.reproduction.checkpoint, 'ready');
    assert.equal(result!.quality.verdict, 'fail');
    const [file] = occluded.evidence.files;
    assert.ok(file && existsSync(file), 'measurements written');
    const evidence = JSON.parse(readFileSync(file, 'utf8')) as {
      checkpoint: string;
      results: unknown[];
    };
    assert.equal(evidence.checkpoint, 'ready');
    assert.deepEqual(
      evidence.results.map(
        (entry) => layoutAuditResultSchema.parse(entry).breakpoint!.name,
      ),
      ['desktop', 'mobile', 'reflow-400'],
    );
  } finally {
    server.close();
  }
});

test('an exception scoped to the mobile viewport applies in the mobile session only', async () => {
  const page = intentionalOverlap.replace(
    '</body>',
    '<a href="/done" style="display:inline-block;padding:12px">Continue</a></body>',
  );
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url === '/done'
        ? '<!doctype html><title>Done</title><h1>Done</h1>'
        : page,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const suite = suiteSchema.parse({
      name: 'scoped',
      baseURL: `http://127.0.0.1:${port}`,
      viewports: [
        { name: 'desktop', width: 1280, height: 800 },
        { name: 'mobile', width: 390, height: 844 },
      ],
      audits: {
        checks: [
          {
            id: 'layout.responsive',
            at: ['ready'],
            rules: ['clipping'],
            matrix: { reflow: false },
            exceptions: [
              {
                rule: 'clipping',
                selector: '.carousel',
                reason: 'Swipe carousel on phones',
                breakpoints: ['mobile'],
              },
            ],
          },
        ],
      },
      journeys: [
        {
          id: 'launch',
          goal: 'Continue',
          persona: 'A visitor',
          startPath: '/',
          allowedPaths: ['/', '/done'],
          ready: {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Spring launch' },
          },
          success: [{ kind: 'path', pattern: '^/done$' }],
          maxSteps: 3,
          maxDurationMs: 30000,
        },
      ],
    });
    const models: Models = {
      async plan() {
        return { objective: 'Continue', concerns: [] };
      },
      async choose(_journey, _observation, _plan, actions) {
        return {
          type: 'choice',
          choice:
            actions.find(
              (action) =>
                action.kind === 'link' && action.href.endsWith('/done'),
            )?.id ?? 'no_match',
          confidence: 1,
          probabilities: {},
        };
      },
    };
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-layout-')),
      'run',
    );
    const results = await runSuite(suite, models, { directory });
    const byViewport = Object.fromEntries(
      results.map((result) => [result.viewport, result]),
    );
    const carousel = 'body > div:nth-of-type(1)';
    const desktop = byViewport.desktop!.audits;
    const mobile = byViewport.mobile!.audits;
    assert.equal(desktop.runs[0]!.status, 'findings');
    assert.ok(
      desktop.findings.some((finding) =>
        finding.targets.some((target) => target.selector === carousel),
      ),
    );
    assert.deepEqual(desktop.runs[0]!.exemptions, []);
    // On mobile the carousel is exempted, visibly; the promo label is not.
    assert.deepEqual(
      mobile.runs[0]!.exemptions.map((entry) => entry.target.selector),
      [carousel],
    );
    assert.ok(
      !mobile.findings.some((finding) =>
        finding.targets.some((target) => target.selector === carousel),
      ),
    );
    assert.ok(
      mobile.findings.some((finding) =>
        finding.targets.some((target) => target.selector === 'body > p'),
      ),
    );
  } finally {
    server.close();
  }
});

test('a matrix entry named like the session viewport is measured once; another size is an error', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(clippedLabel.defect);
    const directory = await mkdtemp(join(tmpdir(), 'ui-ux-layout-'));
    const request = (matrix: unknown) => ({
      config: auditConfigSchema.parse({ id: 'layout.responsive', matrix }),
      checkpoint: {
        id: 'ready',
        kind: 'ready' as const,
        name: null,
        step: 0,
        url: null,
        screenshot: null,
      },
      directory,
      scope: { suite: 'layout', journey: 'matrix' },
      baselines: null,
      timeoutMs: 15000,
      viewport: { name: 'mobile', width: 390, height: 844 },
    });
    const output = auditOutputSchema.parse(
      await layoutResponsivePlaywrightAudit(
        page,
        request({
          breakpoints: [{ name: 'mobile', width: 390, height: 844 }],
          reflow: false,
        }),
      ),
    );
    assert.equal(output.observations, 1);
    assert.deepEqual(
      output.findings.map((finding) => finding.ruleId),
      ['clipped-content'],
    );
    assert.deepEqual(output.findings[0]!.tags, ['breakpoint:mobile']);
    await assert.rejects(
      layoutResponsivePlaywrightAudit(
        page,
        request({ breakpoints: [{ name: 'mobile', width: 400, height: 844 }] }),
      ),
      /Breakpoint mobile is 400x844 but the session's mobile viewport is 390x844/,
    );
  } finally {
    await context.close();
  }
});
