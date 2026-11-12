import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { auditConfigSchema, type AuditConfig } from '../src/audits/config.js';
import {
  auditOutputSchema,
  type ParsedAuditOutput,
} from '../src/audits/contract.js';
import {
  deltaE2000Lab,
  designTokenSetSchema,
  loadDesignTokens,
  parseColor,
  parseTokenFile,
} from '../src/audits/design-tokens.js';
import { AUDITS } from '../src/audits/registry.js';
import {
  suiteSchema,
  type Action,
  type Choice,
  type Journey,
} from '../src/contracts.js';
import { PLAYWRIGHT_AUDITS } from '../src/drivers/playwright-audits.js';
import type { DriverAuditRequest } from '../src/drivers/types.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import {
  DTCG_TOKENS,
  TOKENS,
  nearToken,
  offToken,
  onToken,
} from './fixtures/design.js';

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

const config = (options: Record<string, unknown> = {}): AuditConfig =>
  auditConfigSchema.parse({ id: 'design.tokens', tokens: TOKENS, ...options });

// Runs the audit's Playwright implementation on a page with `html`.
async function audit(
  html: string,
  check: AuditConfig = config(),
  // Runs in the page before the audit (test stubs of browser behaviour).
  prepare?: (page: Page) => Promise<void>,
): Promise<{ output: ParsedAuditOutput; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-design-'));
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  try {
    await page.setContent(html);
    await prepare?.(page);
    const request: DriverAuditRequest = {
      config: check,
      checkpoint: {
        id: 'ready',
        kind: 'ready',
        name: null,
        step: 0,
        url: page.url(),
        screenshot: null,
      },
      viewport: { name: 'desktop', width: 1024, height: 768 },
      directory,
      scope: { suite: 'design fixture', journey: 'trip' },
      baselines: null,
      timeoutMs: 15000,
    };
    const raw = await PLAYWRIGHT_AUDITS['design.tokens']!(page, request);
    return { output: auditOutputSchema.parse(raw), directory };
  } finally {
    await page.close();
  }
}

const violations = (output: ParsedAuditOutput) =>
  output.findings.filter((finding) => finding.certainty === 'violation');
const byRule = (output: ParsedAuditOutput, rule: string) =>
  output.findings.filter((finding) => finding.ruleId === rule);

test('token sets are validated at the boundary', () => {
  assert.ok(designTokenSetSchema.safeParse(TOKENS).success);
  // A malformed colour, an unknown unit and an empty set are configuration
  // errors, never an empty check.
  for (const bad of [
    { version: 1, color: { brand: 'blue-ish' } },
    { version: 1, spacing: { s1: '4em' } },
    { version: 1 },
    { version: 1, color: {} },
    { version: 2, color: { ink: '#000' } },
    { version: 1, colour: { ink: '#000' } },
  ])
    assert.equal(
      designTokenSetSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  assert.throws(() => config({ tokens: { version: 1 } }));
  // Unknown options are rejected like every audit entry.
  assert.throws(() => config({ treshold: 2 }));
  // The audit entry takes the shared per-audit fields.
  assert.equal(config({ timeoutMs: 30000 }).timeoutMs, 30000);
});

test('colours parse to sRGB and CIEDE2000 matches the reference data', () => {
  assert.deepEqual(parseColor('#0b5fff'), [11, 95, 255, 1]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#00000080'), [0, 0, 0, 128 / 255]);
  assert.deepEqual(parseColor('rgb(11, 95, 255)'), [11, 95, 255, 1]);
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), [0, 0, 0, 0.5]);
  assert.equal(parseColor('blue-ish'), null);
  // Sharma, Wu and Dalal (2005), pairs 1, 7 and 17.
  const pairs: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
  ];
  for (const [a, b, expected] of pairs)
    assert.ok(
      Math.abs(
        deltaE2000Lab(
          a as [number, number, number],
          b as [number, number, number],
        ) - expected,
      ) < 1e-4,
      `${a} vs ${b}`,
    );
});

test('W3C design tokens (DTCG) convert to the native token set', () => {
  const set = parseTokenFile(DTCG_TOKENS, 'tokens.json');
  assert.equal(set.name, 'tokens.json');
  assert.equal(set.color?.['color.brand'], '#0b5fff');
  // An alias resolves to the referenced token's value.
  assert.equal(set.color?.['color.action'], '#0b5fff');
  assert.equal(
    set.fontFamily?.['font.family.body'],
    'Inter, Arial, sans-serif',
  );
  assert.equal(set.fontSize?.['fontSize.md'], '1rem');
  assert.equal(set.spacing?.['spacing.s3'], '1rem');
  assert.equal(set.radius?.['radius.md'], '8px');
  // Token types the audit does not check are counted, never silently dropped.
  assert.deepEqual(set.ignored, [
    'font.weight.bold (fontWeight)',
    'shadow.card (shadow)',
  ]);
  // A native file keeps its own name and is validated strictly.
  assert.equal(parseTokenFile(TOKENS, 'x.json').name, 'fixture tokens');
  assert.throws(
    () =>
      parseTokenFile(
        { color: { a: { $value: '{color.b}' }, b: { $value: '{color.a}' } } },
        'loop.json',
      ),
    /alias/i,
  );
  assert.throws(
    () =>
      parseTokenFile({ color: { a: { $value: '{color.missing}' } } }, 'x.json'),
    /Unknown alias \{color\.missing\}/,
  );
  assert.throws(
    () => parseTokenFile({ notes: 'nothing here' }, 'empty.json'),
    /token/i,
  );
});

test('a token file is resolved relative to the suite file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-ux-design-suite-'));
  await mkdir(join(root, 'design'));
  await writeFile(
    join(root, 'design', 'tokens.json'),
    JSON.stringify(DTCG_TOKENS),
  );
  const suitePath = join(root, 'suite.json');
  const suite = suiteSchema.parse({
    name: 'Tokens',
    baseURL: 'http://127.0.0.1:1',
    viewports: [{ name: 'desktop', width: 1024, height: 768 }],
    audits: { checks: [{ id: 'design.tokens', tokens: 'design/tokens.json' }] },
    journeys: [
      {
        id: 'trip',
        goal: 'Look',
        persona: 'A visitor',
        startPath: '/',
        allowedPaths: ['/'],
        ready: { kind: 'path', pattern: '^/$' },
        success: [{ kind: 'path', pattern: '^/$' }],
      },
    ],
  });
  const loaded = await loadDesignTokens(suite, suitePath);
  const check = loaded.audits.checks[0]!;
  assert.equal(check.id, 'design.tokens');
  if (check.id !== 'design.tokens') return;
  assert.equal(typeof check.tokens, 'object');
  assert.equal(
    typeof check.tokens === 'object' && check.tokens.name,
    'design/tokens.json',
  );
  // The parsed suite itself is not changed.
  assert.equal(
    (suite.audits.checks[0] as { tokens: unknown }).tokens,
    'design/tokens.json',
  );
  // A missing or invalid file names the file it read.
  await assert.rejects(
    loadDesignTokens(suite, join(root, 'elsewhere', 'suite.json')),
    /elsewhere\/design\/tokens\.json/,
  );
  await writeFile(
    join(root, 'design', 'tokens.json'),
    '{"version":1,"color":{"ink":"nope"}}',
  );
  await assert.rejects(
    loadDesignTokens(suite, suitePath),
    /design\/tokens\.json/,
  );
});

test('an on-token page is clean, and a tolerance absorbs rounding drift', async () => {
  const { output } = await audit(onToken);
  assert.deepEqual(
    output.findings,
    [],
    JSON.stringify(output.findings, null, 1),
  );
  assert.equal(output.complete, true);
  assert.ok(output.observations >= 1);
  // A clean run says what it measured: zero checked is never health.
  assert.match(output.detail ?? '', /\d+ elements/);
  assert.ok(!/^0 elements/.test(output.detail ?? ''));
  // Relative (5%) and auto values are counted as not compared.
  assert.ok(
    output.limitations.some((line) => /percent|relative/i.test(line)),
    output.limitations.join('\n'),
  );
  // Never a comparison with design files or a judgement of looks.
  assert.ok(output.limitations.some((line) => /Figma/.test(line)));
  const near = await audit(nearToken);
  assert.deepEqual(near.output.findings, []);
  // With no tolerance the same drift is reported.
  const strict = await audit(
    nearToken,
    config({ tolerance: { colorDeltaE: 0, lengthPx: 0 } }),
  );
  assert.deepEqual(
    [
      ...new Set(strict.output.findings.map((finding) => finding.ruleId)),
    ].sort(),
    ['color', 'font-size'],
  );
});

test('an off-token page reports each seeded value with its nearest token', async () => {
  const { output, directory } = await audit(offToken);
  // Every finding is an observed measurement, never a hypothesis.
  assert.ok(
    output.findings.every((finding) => finding.certainty === 'violation'),
  );
  assert.ok(
    output.findings.every((finding) => finding.severity === 'moderate'),
  );
  assert.deepEqual(
    [...new Set(output.findings.map((finding) => finding.ruleId))].sort(),
    ['color', 'font-family', 'font-size', 'radius', 'spacing'],
  );
  const colors = byRule(output, 'color');
  const background = colors.find((finding) =>
    finding.description.includes('#ff5a1f'),
  );
  assert.ok(
    background,
    colors.map((finding) => finding.description).join('\n'),
  );
  assert.match(background.description, /background-color/);
  assert.match(background.description, /nearest token danger \(#e5484d\)/);
  assert.match(background.description, /ΔE2000 \d+(\.\d)?/);
  assert.equal(background.nodeCount, 1);
  assert.match(background.targets[0]!.selector ?? '', /button/);
  assert.match(background.targets[0]!.reason ?? '', /danger/);
  const text = colors.find((finding) =>
    finding.description.includes('#555555'),
  );
  assert.ok(text);
  assert.match(text.description, /text color/);
  assert.match(text.description, /nearest token ink/);
  const [size] = byRule(output, 'font-size');
  assert.match(size!.description, /13px/);
  assert.match(size!.description, /nearest token sm \(14px\), 1px away/);
  const [spacing] = byRule(output, 'spacing');
  assert.match(spacing!.description, /10px/);
  assert.match(spacing!.description, /padding/);
  assert.match(spacing!.description, /nearest token s2 \(8px\), 2px away/);
  const [radius] = byRule(output, 'radius');
  assert.match(radius!.description, /6px/);
  const [family] = byRule(output, 'font-family');
  assert.match(family!.description, /georgia/i);
  assert.match(family!.description, /body \(Inter\)/);
  // The partner badge's #ffcc00 is reported too until the suite exempts it.
  assert.ok(colors.some((finding) => finding.description.includes('#ffcc00')));
  // The full measurement is evidence in the run directory, linked from
  // every finding.
  const file = output.findings[0]!.files[0]!;
  assert.ok(file.startsWith(directory));
  const evidence = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(evidence.tokens.name, 'fixture tokens');
  assert.ok(evidence.offToken.length >= output.findings.length);
  // Evidence carries values and selectors, not page text.
  assert.ok(!JSON.stringify(evidence).includes('Search trips'));
});

test('a configured exception exempts its elements and lists them as exemptions', async () => {
  const { output } = await audit(
    offToken,
    config({
      exceptions: [
        {
          selector: '.partner',
          rules: ['color'],
          reason: 'Partner badges use the partner brand colour',
        },
        { selector: '.no-such-thing', reason: 'Stale exception' },
      ],
    }),
  );
  assert.ok(
    !output.findings.some((finding) => finding.description.includes('#ffcc00')),
  );
  const exemption = output.exemptions.find((entry) =>
    entry.target.reason?.includes('#ffcc00'),
  );
  assert.ok(exemption, JSON.stringify(output.exemptions));
  assert.equal(exemption.ruleId, 'color');
  assert.match(exemption.reason, /partner brand colour/);
  assert.match(exemption.target.selector ?? '', /partner-badge|span/);
  // An exception scoped to color does not hide other rules on the element;
  // the stale exception is reported.
  assert.ok(output.limitations.some((line) => /\.no-such-thing/.test(line)));
  // The other seeded findings stay.
  assert.equal(violations(output).length, byRule(output, 'color').length + 4);
});

test('scope, rules and coverage are explicit', async () => {
  // A scope selector that matches nothing is an audit error, not clean.
  await assert.rejects(
    audit(offToken, config({ include: ['#missing'] })),
    /matched nothing/,
  );
  // An invalid selector is an error too.
  await assert.rejects(audit(offToken, config({ include: ['[['] })));
  // Scoped to the card: the button and hint outside it are not measured.
  const card = await audit(
    offToken,
    config({ include: ['.card'], exclude: ['.hint'] }),
  );
  assert.deepEqual(
    card.output.findings.map((finding) => finding.ruleId),
    ['font-family'],
  );
  assert.ok(card.output.limitations.some((line) => /\.card/.test(line)));
  // Only the selected rules run.
  const colorOnly = await audit(offToken, config({ rules: ['color'] }));
  assert.deepEqual(
    [...new Set(colorOnly.output.findings.map((finding) => finding.ruleId))],
    ['color'],
  );
  // A rule whose category the token set does not define cannot be checked.
  await assert.rejects(
    audit(
      offToken,
      config({
        tokens: { version: 1, color: { ink: '#1a1f36' } },
        rules: ['spacing'],
      }),
    ),
    /no spacing tokens/,
  );
  // Without a rule list, only the categories the set defines are checked,
  // and the others are listed as not checked.
  const colorsOnly = await audit(
    offToken,
    config({ tokens: { version: 1, color: TOKENS.color } }),
  );
  assert.deepEqual(
    [...new Set(colorsOnly.output.findings.map((finding) => finding.ruleId))],
    ['color'],
  );
  assert.ok(
    colorsOnly.output.limitations.some((line) =>
      /^Not checked:.*spacing \(no spacing tokens/.test(line),
    ),
  );
  // An empty scope region measures nothing: incomplete, never clean.
  const empty = await audit(
    '<!doctype html><html><body><div id="empty" style="display:none"></div></body></html>',
    config({ include: ['#empty'] }),
  );
  assert.equal(empty.output.complete, false);
  // An element cap stops the walk: incomplete, with the reason.
  const capped = await audit(offToken, config({ maxElements: 3 }));
  assert.equal(capped.output.complete, false);
  assert.match(capped.output.detail ?? '', /maxElements/);
  // The same tokens from the W3C format measure the same page the same way,
  // and the token types not checked are listed on the run.
  const dtcg = await audit(
    onToken,
    config({ tokens: parseTokenFile(DTCG_TOKENS, 'tokens.json') }),
  );
  assert.deepEqual(dtcg.output.findings, []);
  assert.ok(
    dtcg.output.limitations.some((line) =>
      /font\.weight\.bold \(fontWeight\)/.test(line),
    ),
  );
  // A token path the loader never resolved is an error that says how.
  await assert.rejects(
    audit(onToken, config({ tokens: 'design/tokens.json' })),
    /not loaded/,
  );
});

test('the audit is opt-in, web-only and documented by its example suite', async () => {
  const suite = suiteSchema.parse({
    name: 'x',
    baseURL: 'http://127.0.0.1:1',
    viewports: [{ name: 'desktop', width: 1024, height: 768 }],
    journeys: [
      {
        id: 'trip',
        goal: 'Look',
        persona: 'A visitor',
        startPath: '/',
        allowedPaths: ['/'],
        ready: { kind: 'path', pattern: '^/$' },
        success: [{ kind: 'path', pattern: '^/$' }],
      },
    ],
  });
  assert.ok(!suite.audits.checks.some((check) => check.id === 'design.tokens'));
  assert.deepEqual(AUDITS['design.tokens'].drivers, ['playwright']);
  assert.equal(AUDITS['design.tokens'].evaluate, undefined);
  const examplePath = 'examples/design-tokens.json';
  const example = await loadDesignTokens(
    suiteSchema.parse(JSON.parse(readFileSync(examplePath, 'utf8'))),
    examplePath,
  );
  const check = example.audits.checks.find(
    (entry) => entry.id === 'design.tokens',
  );
  assert.ok(
    check && check.id === 'design.tokens' && typeof check.tokens === 'object',
  );
});

// ---- Through a real journey ----

async function site(pages: { start: string; done: string }) {
  const finish = (html: string) =>
    html.replace('</main>', '<p><a href="/done">Finish</a></p></main>');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(finish(request.url === '/done' ? pages.done : pages.start));
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
        (action) =>
          action.kind === 'link' && action.description.includes('Finish'),
      )?.id ?? 'no_match',
      actions,
    );
  },
};

test('through a real journey: off-token values at ready, clean at completion', async () => {
  const app = await site({ start: offToken, done: onToken });
  try {
    const parent = await mkdtemp(join(tmpdir(), 'ui-ux-design-journey-'));
    const [result] = await runSuite(
      suiteSchema.parse({
        name: 'LOCAL fixture — design tokens',
        baseURL: app.url,
        requiresAuth: false,
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        journeys: [journey],
        audits: {
          failOn: 'moderate',
          checks: [
            {
              id: 'design.tokens',
              tokens: TOKENS,
              exceptions: [
                {
                  selector: '.partner',
                  rules: ['color'],
                  reason: 'Partner colour',
                },
              ],
            },
          ],
        },
      }),
      deterministic,
      { directory: join(parent, 'run') },
    );
    assert.ok(result);
    // The functional outcome is independent of the audit.
    assert.equal(result.status, 'passed');
    const runs = result.audits.runs.filter(
      (entry) => entry.auditId === 'design.tokens',
    );
    assert.deepEqual(
      runs.map((entry) => [entry.checkpoint.id, entry.status]),
      [
        ['ready', 'findings'],
        ['completion', 'clean'],
      ],
    );
    assert.equal(runs[0]!.source, 'builtin');
    assert.ok(runs[0]!.exemptions.length >= 1);
    const findings = result.audits.findings.filter(
      (finding) => finding.auditId === 'design.tokens',
    );
    assert.equal(findings.length, 6);
    // moderate findings gate at failOn moderate.
    assert.ok(findings.every((finding) => finding.gating));
    assert.equal(result.quality.verdict, 'fail');
  } finally {
    await app.close();
  }
});

// WebKit's computedStyleMap() can return lengths as untyped CSSStyleValue
// objects instead of CSSUnitValue. Stubbed here in Chromium: every px length
// the map would return for margin, padding and gap becomes an untyped value
// with the same text, and `.card`'s padding-top an unreadable one when asked.
// Plain page JavaScript (a string, so the test transpiler adds no helpers).
const untypedLengths = (unreadable: string | null) => async (page: Page) => {
  await page.evaluate(`(() => {
    const unreadable = ${JSON.stringify(unreadable)};
    const untyped = (text) =>
      Object.assign(Object.create(CSSStyleValue.prototype), { toString: () => text });
    const original = Element.prototype.computedStyleMap;
    Element.prototype.computedStyleMap = function () {
      const map = original.call(this);
      const element = this;
      return new Proxy(map, {
        get(target, key) {
          if (key !== 'get') return Reflect.get(target, key, target);
          return (property) => {
            if (unreadable !== null && element.classList.contains('card') && property === 'padding-top')
              return untyped(unreadable);
            const value = target.get(property);
            return /^(margin|padding)-|gap$/.test(property) &&
              value instanceof CSSUnitValue && value.unit === 'px'
              ? untyped(value.toString())
              : value;
          };
        },
      });
    };
  })()`);
};

test('untyped Typed OM lengths are parsed as px, anything else leaves the run incomplete', async () => {
  // Still measured: on token stays clean and complete...
  const clean = await audit(onToken, config(), untypedLengths(null));
  assert.deepEqual(clean.output.findings, []);
  assert.equal(clean.output.complete, true, clean.output.detail ?? '');
  // ...and the seeded 10px padding is still found, with its nearest token.
  const off = await audit(offToken, config(), untypedLengths(null));
  const [spacing] = byRule(off.output, 'spacing');
  assert.ok(spacing, JSON.stringify(off.output.findings));
  assert.match(
    spacing.description,
    /10px .*nearest token s2 \(8px\), 2px away/,
  );
  assert.equal(off.output.complete, true);
  // An untyped percentage or calc() is a relative value, exactly like a
  // typed one: counted, not compared, and the run stays complete (WebKit
  // returns % padding untyped, so pages with it would otherwise never be
  // measured completely).
  const relative = (output: ParsedAuditOutput) =>
    Number(
      /(\d+) relative value/.exec(output.limitations.join('\n'))?.[1] ?? 0,
    );
  for (const text of ['5%', 'calc(10px + 5%)']) {
    const counted = await audit(onToken, config(), untypedLengths(text));
    assert.equal(counted.output.complete, true, `${text}: ${counted.output.detail}`);
    assert.doesNotMatch(counted.output.detail ?? '', /untyped value/, text);
    assert.equal(relative(counted.output), relative(clean.output) + 1, text);
    assert.deepEqual(counted.output.findings, [], text);
  }
  // A value that does not parse, or parses to a length that is not px, is
  // not guessed: the run is incomplete and says why.
  for (const text of ['not-a-length', '2em']) {
    const unreadable = await audit(onToken, config(), untypedLengths(text));
    assert.equal(unreadable.output.complete, false, text);
    assert.match(unreadable.output.detail ?? '', /1 untyped value/, text);
  }
});
