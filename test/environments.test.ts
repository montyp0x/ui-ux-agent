// Suite-owned environments (src/environments.ts): explicit, capped selection
// of environment × viewport combinations, the emulation each run applies
// (verified in the page), pseudo-localized long text, and environment as part
// of results, identity, summary, report and comparison. Real Chromium runs on
// local fixtures; no model calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { baselineDirectory } from '../src/audits/visual.js';
import { check } from '../src/browser.js';
import { compareRuns, findingInstances, loadRun } from '../src/compare.js';
import { gateSchema } from '../src/gate.js';
import { suiteSchema, type Action, type Choice } from '../src/contracts.js';
import {
  markPseudoLocalized,
  pseudoLocalizationScript,
  pseudoNamePattern,
  pseudoPad,
  selectCombinations,
  unappliedSettings,
  withoutPseudo,
} from '../src/environments.js';
import type { Models } from '../src/models.js';
import { parseResults, type Result } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { summarize } from '../src/summary.js';

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];
const journey = {
  id: 'finish',
  goal: 'Finish the task',
  persona: 'A first-time visitor',
  startPath: '/',
  allowedPaths: ['/', '/done'],
  ready: { kind: 'path', pattern: '^/$' },
  success: [{ kind: 'path', pattern: '^/done$' }],
  maxSteps: 4,
  maxDurationMs: 30000,
};
const base = {
  name: 'environments',
  baseURL: 'https://app.example',
  viewports,
  journeys: [journey],
};
const issues = (raw: unknown): string[] => {
  const parsed = suiteSchema.safeParse(raw);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
};

test('a suite with environments lists its combinations explicitly, in run order', () => {
  const suite = suiteSchema.parse({
    ...base,
    environments: [
      { name: 'light', colorScheme: 'light', locale: 'en-US' },
      {
        name: 'dark',
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        forcedColors: 'none',
        contrast: 'more',
        timezone: 'Europe/Berlin',
      },
      { name: 'long-text', locale: 'de-DE', pseudoLocalization: {} },
    ],
    combinations: [
      { environment: 'dark', viewport: 'mobile' },
      { environment: 'light', viewport: 'desktop' },
      { environment: 'long-text', viewport: 'mobile' },
    ],
  });
  assert.deepEqual(selectCombinations(suite), {
    combinations: [
      { environment: 'dark', viewport: 'mobile' },
      { environment: 'light', viewport: 'desktop' },
      { environment: 'long-text', viewport: 'mobile' },
    ],
    issues: [],
  });
  // Suites without environments select nothing here: every viewport runs.
  assert.deepEqual(selectCombinations(suiteSchema.parse(base)), {
    combinations: [],
    issues: [],
  });
});

test('the example environments suite selects five combinations', async () => {
  const suite = suiteSchema.parse(
    JSON.parse(await readFile(new URL('../examples/environments.json', import.meta.url), 'utf8')),
  );
  assert.deepEqual(
    selectCombinations(suite).combinations.map(
      (cell) => `${cell.environment}/${cell.viewport}`,
    ),
    [
      'light/desktop',
      'dark/desktop',
      'dark/narrow',
      'high-contrast/desktop',
      'long-text/narrow',
    ],
  );
});

test('environments without an explicit selection are refused, never multiplied out', () => {
  const messages = issues({
    ...base,
    environments: [{ name: 'light' }, { name: 'dark', colorScheme: 'dark' }],
  });
  assert.equal(messages.length, 1);
  assert.match(
    messages[0]!,
    /must list the environment × viewport combinations to run.*never expand to every combination implicitly/,
  );
});

test('a matrix needs an explicit cap; over its cap the suite is invalid, naming the count', () => {
  const environments = [
    { name: 'light' },
    { name: 'dark', colorScheme: 'dark' },
    { name: 'long-text', pseudoLocalization: { expansion: 0.5 } },
  ];
  assert.deepEqual(
    issues({
      ...base,
      environments,
      matrix: {
        environments: ['light', 'dark'],
        viewports: ['desktop', 'mobile'],
      },
    }),
    [
      'matrix.max is required: the most environment × viewport combinations the matrix may select',
    ],
  );
  const over = issues({
    ...base,
    environments,
    matrix: {
      environments: ['light', 'dark', 'long-text'],
      viewports: ['desktop', 'mobile'],
      max: 4,
    },
  });
  assert.deepEqual(over, [
    'matrix selects 6 environment × viewport combinations (3 environments × 2 viewports - 0 excluded + 0 included), over its max of 4; exclude combinations, list them in combinations, or raise max (at most 24)',
  ]);
  // The same matrix within its cap, with exclude and include.
  const suite = suiteSchema.parse({
    ...base,
    environments,
    matrix: {
      environments: ['light', 'dark'],
      viewports: ['desktop', 'mobile'],
      exclude: [{ environment: 'light', viewport: 'mobile' }],
      include: [{ environment: 'long-text', viewport: 'mobile' }],
      max: 4,
    },
  });
  assert.deepEqual(
    selectCombinations(suite).combinations.map(
      (cell) => `${cell.environment}/${cell.viewport}`,
    ),
    ['light/desktop', 'dark/desktop', 'dark/mobile', 'long-text/mobile'],
  );
  // The hard ceiling.
  assert.ok(
    issues({
      ...base,
      environments,
      matrix: { environments: ['light'], viewports: ['desktop'], max: 25 },
    }).length,
  );
});

test('environment selection problems are configuration errors', () => {
  const environments = [{ name: 'light' }, { name: 'dark', colorScheme: 'dark' }];
  const cases: [unknown, RegExp][] = [
    [
      {
        ...base,
        environments,
        combinations: [{ environment: 'sepia', viewport: 'desktop' }],
      },
      /unknown environment sepia/,
    ],
    [
      {
        ...base,
        environments,
        combinations: [{ environment: 'dark', viewport: 'tablet' }],
      },
      /unknown viewport tablet/,
    ],
    [
      {
        ...base,
        environments,
        combinations: [
          { environment: 'dark', viewport: 'desktop' },
          { environment: 'dark', viewport: 'desktop' },
        ],
      },
      /dark\/desktop is selected twice/,
    ],
    [
      {
        ...base,
        environments: [{ name: 'dark' }, { name: 'dark' }],
        combinations: [{ environment: 'dark', viewport: 'desktop' }],
      },
      /Environment names must be unique/,
    ],
    [
      {
        ...base,
        environments,
        combinations: [{ environment: 'dark', viewport: 'desktop' }],
        matrix: { environments: ['dark'], viewports: ['desktop'], max: 1 },
      },
      /combinations or matrix, not both/,
    ],
    [
      { ...base, combinations: [{ environment: 'dark', viewport: 'desktop' }] },
      /add environments/,
    ],
    [
      {
        ...base,
        environments,
        matrix: {
          environments: ['dark'],
          viewports: ['desktop'],
          exclude: [{ environment: 'light', viewport: 'desktop' }],
          max: 1,
        },
      },
      /exclude\[0\] light\/desktop is not in environments × viewports/,
    ],
    [
      {
        ...base,
        environments: [{ name: 'de', locale: 'not a locale!' }],
        combinations: [{ environment: 'de', viewport: 'desktop' }],
      },
      /BCP 47/,
    ],
    [
      {
        ...base,
        environments: [{ name: 'mars', timezone: 'Mars/Olympus' }],
        combinations: [{ environment: 'mars', viewport: 'desktop' }],
      },
      /IANA time zone/,
    ],
    [
      {
        ...base,
        environments: [{ name: 'dark', colorScheme: 'sepia' }],
        combinations: [{ environment: 'dark', viewport: 'desktop' }],
      },
      /colorScheme/,
    ],
    [
      {
        name: 'native',
        platform: 'macos',
        app: { bundleId: 'com.apple.calculator' },
        environments,
        combinations: [{ environment: 'dark', viewport: 'window' }],
        journeys: [
          {
            id: 'add',
            goal: 'Add',
            persona: 'A user',
            ready: { kind: 'visible', target: { by: 'role', role: 'button', name: '1' } },
            success: [{ kind: 'visible', target: { by: 'role', role: 'button', name: '2' } }],
          },
        ],
      },
      /environments apply to web suites only/,
    ],
  ];
  for (const [raw, pattern] of cases) {
    const messages = issues(raw);
    assert.ok(
      messages.some((message) => pattern.test(message)) ||
        // zod's own messages name the path for enum errors.
        (pattern.source === 'colorScheme' && messages.length > 0),
      `${pattern}: got ${JSON.stringify(messages)}`,
    );
  }
});

test('a setting the page does not show is reported as not applied', () => {
  const probe = {
    locale: 'en-US',
    timezone: 'UTC',
    colorScheme: 'light' as const,
    reducedMotion: 'no-preference' as const,
    forcedColors: 'none' as const,
    contrast: 'no-preference' as const,
  };
  assert.deepEqual(
    unappliedSettings(
      { name: 'dark', colorScheme: 'dark', locale: 'en-us', forcedColors: 'active' },
      probe,
    ),
    ['colorScheme dark (page reports light)', 'forcedColors active (page reports none)'],
  );
  assert.deepEqual(unappliedSettings({ name: 'defaults' }, probe), []);
  // A time zone alias is the zone the page reports by its canonical name.
  assert.deepEqual(
    unappliedSettings(
      { name: 'east', timezone: 'US/Eastern' },
      { ...probe, timezone: 'America/New_York' },
    ),
    [],
  );
  assert.deepEqual(
    unappliedSettings(
      { name: 'east', timezone: 'US/Eastern' },
      { ...probe, timezone: 'America/Chicago' },
    ),
    ['timezone US/Eastern (page reports America/Chicago)'],
  );
});

test('two runs that would share an evidence directory are a configuration error', () => {
  // dark × mobile-wide and dark-mobile × wide both name finish-dark-mobile-wide.
  const shared = issues({
    ...base,
    viewports: [
      { name: 'mobile-wide', width: 600, height: 800 },
      { name: 'wide', width: 1600, height: 900 },
    ],
    environments: [
      { name: 'dark', colorScheme: 'dark' },
      { name: 'dark-mobile', colorScheme: 'dark' },
    ],
    combinations: [
      { environment: 'dark', viewport: 'mobile-wide' },
      { environment: 'dark-mobile', viewport: 'wide' },
    ],
  });
  assert.ok(
    shared.some((message) =>
      /finish\/dark\/mobile-wide and finish\/dark-mobile\/wide would share the evidence directory finish-dark-mobile-wide/.test(
        message,
      ),
    ),
    JSON.stringify(shared),
  );
  // Without environments: journey a-b on viewport c and journey a on b-c.
  const plain = issues({
    ...base,
    viewports: [
      { name: 'c', width: 1280, height: 800 },
      { name: 'b-c', width: 390, height: 844 },
    ],
    journeys: [
      { ...journey, id: 'a-b' },
      { ...journey, id: 'a' },
    ],
  });
  assert.ok(
    plain.some((message) => /a-b\/c and a\/b-c would share/.test(message)),
    JSON.stringify(plain),
  );
  assert.deepEqual(issues(base), []);
});

test('pseudo-localization appends marked, deterministic padding and keeps the original text', () => {
  const padded = pseudoPad('Save');
  assert.match(padded, /^Save ⟦[^⟧]{2,}⟧$/);
  assert.equal(pseudoPad('Save'), padded, 'deterministic');
  assert.equal(withoutPseudo(padded), 'Save');
  // Whitespace around the text is kept; blank text is unchanged.
  assert.match(pseudoPad('  Billing email \n'), /^ {2}Billing email ⟦[^⟧]+⟧ \n$/);
  assert.equal(pseudoPad('   '), '   ');
  // Tiered by default (short strings grow most); expansion overrides.
  const grown = (text: string, expansion?: number) =>
    /⟦([^⟧]*)⟧/.exec(pseudoPad(text, expansion))![1]!.replace(/ /g, '').length;
  assert.equal(grown('Save draft'), 10);
  assert.equal(grown('Save draft', 0.5), 5);
  const long = 'a'.repeat(100);
  assert.equal(grown(long), 30);
  // A suite's target name still matches a padded accessible name, also when
  // the name spans several padded text nodes.
  const name = pseudoNamePattern('Save draft');
  assert.ok(name.test(pseudoPad('Save draft')));
  assert.ok(name.test(`${pseudoPad('Save')} ${pseudoPad('draft')}`));
  assert.ok(name.test('Save draft'));
  assert.ok(!name.test('Save draft now'));
  assert.ok(pseudoNamePattern('Price (USD) $5.00?').test(pseudoPad('Price (USD) $5.00?')));
});

test('the pseudo-localization script pads page text but never field values or editable content', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript({
      content: pseudoLocalizationScript({}),
    });
    const page = await context.newPage();
    await page.setContent(
      `<main><label for="q">Search</label><input id="q" value="preset"><textarea>draft text</textarea><select><option>Monthly</option></select><div contenteditable="true">Editable</div><button>Go</button><p id="late"></p></main>`,
    );
    await page.fill('#q', 'typed by the test');
    await page.evaluate(() => {
      document.getElementById('late')!.textContent = 'Rendered later';
    });
    await page.waitForFunction(
      () => document.getElementById('late')!.textContent!.includes('⟦'),
    );
    const read = await page.evaluate(() => ({
      label: document.querySelector('label')!.textContent,
      button: document.querySelector('button')!.textContent,
      late: document.getElementById('late')!.textContent,
      input: (document.getElementById('q') as HTMLInputElement).value,
      textarea: document.querySelector('textarea')!.value,
      option: document.querySelector('option')!.textContent,
      editable: document.querySelector('[contenteditable]')!.textContent,
    }));
    assert.match(read.label!, /^Search ⟦[^⟧]+⟧$/);
    assert.match(read.button!, /^Go ⟦[^⟧]+⟧$/);
    assert.match(read.late!, /^Rendered later ⟦[^⟧]+⟧$/);
    assert.equal(read.input, 'typed by the test');
    assert.equal(read.textarea, 'draft text');
    assert.equal(read.option, 'Monthly');
    assert.equal(read.editable, 'Editable');
    // Re-rendering the same text does not stack padding.
    await page.evaluate(() => {
      const button = document.querySelector('button')!;
      button.textContent = button.textContent;
    });
    await page.waitForTimeout(50);
    assert.equal(
      (await page.textContent('button'))!.match(/⟦/g)!.length,
      1,
    );
  } finally {
    await browser.close();
  }
});

test('text checks match the application text under pseudo-localization', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript({ content: pseudoLocalizationScript({}) });
    const page = await context.newPage();
    await page.setContent(
      `<main><p id="price"><b>$12</b> / month</p></main>`,
    );
    await page.waitForFunction(
      () => document.getElementById('price')!.textContent!.includes('⟦'),
    );
    const condition = {
      kind: 'text' as const,
      target: { by: 'css' as const, value: '#price' },
      pattern: '^\\$\\d+ / month$',
    };
    // The padding follows each text node, so the raw text does not match.
    assert.equal(await check(page, condition), false);
    markPseudoLocalized(page);
    assert.equal(await check(page, condition), true);
    assert.equal(
      await check(page, { ...condition, pattern: '^\\$\\d+ / year$' }),
      false,
    );
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Real runs on local fixtures.

// Readable in light mode; in dark mode the note's text nearly matches its
// background. A Finish link leads to /done.
const CONTRAST_PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Plans</title><style>
body{margin:0;font:16px/1.5 sans-serif;background:#fff;color:#18223a}
main{padding:24px}.note{padding:8px;background:#fff;color:#18223a}
a{color:#0b4bb3}
@media (prefers-color-scheme: dark){body{background:#121212;color:#f0f0f0}.note{background:#2a2a2a;color:#3d3d3d}a{color:#9cc1ff}}
</style></head><body><main><h1>Plans</h1><p class="note">Prices include tax.</p><p><a href="/done">Finish</a></p></main></body></html>`;

// A no-wrap, overflow-hidden label box that fits English text and clips
// longer translations.
const LABEL_PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Billing</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.4 sans-serif;color:#18223a}
main{padding:24px}.field-label{display:block;width:150px;overflow:hidden;white-space:nowrap}
</style></head><body><main><h1>Billing</h1><label class="field-label" for="email">Billing email</label><input id="email" style="width:240px;height:40px"><p><a href="/done">Finish</a></p></main></body></html>`;

const DONE_PAGE = `<!doctype html><html lang="en"><head><title>Done</title></head><body><main><h1>Done</h1></main></body></html>`;

async function site(start: string) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.url === '/done' ? DONE_PAGE : start);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

async function runIn(
  start: string,
  suite: Record<string, unknown>,
  options: { environment?: string } = {},
): Promise<{ results: Result[]; directory: string }> {
  const app = await site(start);
  try {
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-environments-')),
      'run',
    );
    const results = await runSuite(
      suiteSchema.parse({ ...suite, baseURL: app.url }),
      deterministic,
      { directory, ...options },
    );
    return { results, directory };
  } finally {
    await app.close();
  }
}

const byEnvironment = (results: Result[]) =>
  Object.fromEntries(
    results.map((result) => [
      `${result.environment?.name ?? 'none'}/${result.viewport}`,
      result,
    ]),
  );

test('a dark-mode-only contrast defect is found by axe in the dark environment only', async () => {
  const { results, directory } = await runIn(CONTRAST_PAGE, {
    name: 'contrast',
    baseURL: 'http://placeholder.invalid',
    viewports: [viewports[0]],
    environments: [
      { name: 'light', colorScheme: 'light', locale: 'en-US', timezone: 'UTC' },
      {
        name: 'dark',
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
      },
      { name: 'forced', forcedColors: 'active', contrast: 'more' },
    ],
    combinations: [
      { environment: 'light', viewport: 'desktop' },
      { environment: 'dark', viewport: 'desktop' },
      { environment: 'forced', viewport: 'desktop' },
    ],
    audits: { checks: [{ id: 'accessibility.axe', at: ['ready'] }] },
    journeys: [journey],
  });
  assert.equal(results.length, 3);
  const runs = byEnvironment(results);
  const light = runs['light/desktop']!;
  const dark = runs['dark/desktop']!;
  for (const result of [light, dark]) assert.equal(result.status, 'passed', result.reason);
  const contrast = (result: Result) =>
    result.audits.findings.filter((finding) => finding.ruleId === 'color-contrast');
  assert.equal(contrast(light).length, 0, 'light mode is readable');
  assert.equal(contrast(dark).length, 1, 'dark mode note is unreadable');
  assert.match(contrast(dark)[0]!.targets[0]!.selector ?? '', /note/);
  assert.equal(light.quality.verdict, 'pass');
  assert.equal(dark.quality.verdict, 'fail');
  // The environment is part of the result, without synthetic text.
  assert.deepEqual(dark.environment, {
    name: 'dark',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'de-DE',
    timezone: 'Europe/Berlin',
    syntheticText: false,
  });
  // The page itself reported the emulated settings.
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; data: any });
  const applied = events.filter((entry) => entry.event === 'environment_applied');
  assert.deepEqual(
    applied.map((entry) => [entry.data.environment, entry.data.measured]),
    [
      [
        'light',
        {
          locale: 'en-US',
          timezone: 'UTC',
          colorScheme: 'light',
          reducedMotion: 'no-preference',
          forcedColors: 'none',
          contrast: 'no-preference',
        },
      ],
      [
        'dark',
        {
          locale: 'de-DE',
          timezone: 'Europe/Berlin',
          colorScheme: 'dark',
          reducedMotion: 'reduce',
          forcedColors: 'none',
          contrast: 'no-preference',
        },
      ],
      [
        'forced',
        {
          // Unset settings keep the browser's defaults.
          locale: applied[2]!.data.measured.locale,
          timezone: applied[2]!.data.measured.timezone,
          colorScheme: 'light',
          reducedMotion: 'no-preference',
          forcedColors: 'active',
          contrast: 'more',
        },
      ],
    ],
  );
  // Each combination has its own evidence directory and summary row.
  const stored = parseResults(
    await readFile(join(directory, 'results.json'), 'utf8'),
  );
  assert.deepEqual(
    stored.map((result) => result.environment?.name),
    ['light', 'dark', 'forced'],
  );
  assert.ok(
    (await readFile(join(directory, 'finish-dark-desktop', 'result.json'), 'utf8')).includes('"dark"'),
  );
  const summary = JSON.parse(
    await readFile(join(directory, 'summary.json'), 'utf8'),
  ) as { environment: string | null; viewport: string; quality: { fail: number } }[];
  assert.deepEqual(
    summary.map((row) => [row.environment, row.viewport, row.quality.fail]),
    [
      ['light', 'desktop', 0],
      ['dark', 'desktop', 1],
      ['forced', 'desktop', 0],
    ],
  );
  // The run identity records the selection; both results share it.
  assert.deepEqual(light.identity!.suite.selection, {
    journeys: ['finish'],
    viewports: ['desktop'],
    repeat: 1,
    combinations: ['light/desktop', 'dark/desktop', 'forced/desktop'],
  });
  assert.deepEqual(light.identity, dark.identity);
  // Stable finding ids are per environment.
  const [instance] = findingInstances(dark).filter((entry) => entry.ruleId === 'color-contrast');
  assert.equal(instance!.environment, 'dark');
  const relabelled = findingInstances({
    ...dark,
    environment: { ...dark.environment!, name: 'light' },
  }).find((entry) => entry.ruleId === 'color-contrast');
  assert.notEqual(relabelled!.id, instance!.id);
  const report = await readFile(join(directory, 'report.html'), 'utf8');
  assert.match(report, /finish · dark · desktop/);
  // Comparison pairs runs per environment: a candidate without the dark run
  // leaves the dark finding unassessed, never resolved by the light run.
  const loaded = await loadRun(directory, 'base');
  const comparison = compareRuns(
    loaded,
    {
      ...loaded,
      directory: `${directory}-candidate`,
      results: loaded.results!.filter((result) => result.environment?.name !== 'dark'),
    },
    gateSchema.parse({}),
  );
  assert.equal(comparison.compatible, true);
  assert.deepEqual(
    comparison.outcomes.map((outcome) => [outcome.environment, !!outcome.candidate]),
    [
      ['light', true],
      ['dark', false],
      ['forced', true],
    ],
  );
  assert.equal(comparison.findings.resolved.length, 0);
  assert.deepEqual(
    comparison.findings.unassessed.map((entry) => [
      entry.base.ruleId,
      entry.base.environment,
      entry.reason,
      entry.detail,
    ]),
    [['color-contrast', 'dark', 'run_missing', 'The candidate did not run finish/dark/desktop']],
  );
  assert.ok(
    comparison.gate!.failures.some(
      (failure) => failure.message === 'finish/dark/desktop ran in the base but not in the candidate',
    ),
  );
});

test('a long-text-only overflow is found by layout.responsive in the pseudo-localized environment only', async () => {
  const { results, directory } = await runIn(LABEL_PAGE, {
    name: 'long-text',
    baseURL: 'http://placeholder.invalid',
    viewports: [viewports[0]],
    environments: [
      { name: 'english', locale: 'en-US' },
      { name: 'long-text', locale: 'en-US', pseudoLocalization: {} },
    ],
    matrix: {
      environments: ['english', 'long-text'],
      viewports: ['desktop'],
      max: 2,
    },
    audits: {
      checks: [
        {
          id: 'layout.responsive',
          at: ['ready'],
          matrix: { reflow: false },
        },
        // No --baselines directory: each capture is `missing`, keyed by its
        // environment.
        { id: 'visual.baseline', at: ['ready'], networkIdleMs: 0 },
      ],
    },
    // The ready check names the label by its original text: targets still
    // match under pseudo-localization.
    journeys: [
      {
        ...journey,
        ready: {
          kind: 'visible',
          target: { by: 'label', value: 'Billing email' },
        },
      },
    ],
  });
  const runs = byEnvironment(results);
  const english = runs['english/desktop']!;
  const long = runs['long-text/desktop']!;
  for (const result of [english, long]) assert.equal(result.status, 'passed', result.reason);
  const clipped = (result: Result) =>
    result.audits.findings.filter((finding) => finding.tags.includes('rule:clipping') || /clip/.test(finding.ruleId));
  assert.equal(clipped(english).length, 0, 'English text fits');
  assert.ok(clipped(long).length >= 1, 'expanded text is clipped');
  assert.deepEqual(
    [english, long].map((result) => {
      const visual = result.audits.runs.find((run) => run.visual)!.visual!;
      return [visual.status, visual.key.environment];
    }),
    [
      ['missing', 'english'],
      ['missing', 'long-text'],
    ],
  );
  assert.equal(long.environment!.syntheticText, true);
  assert.equal(english.environment!.syntheticText, false);
  // Reports label the synthetic text.
  const report = await readFile(join(directory, 'report.html'), 'utf8');
  assert.match(report, /synthetic text/i);
  // The CLI-style filter runs one environment only.
  const only = await runIn(
    LABEL_PAGE,
    {
      name: 'long-text',
      baseURL: 'http://placeholder.invalid',
      viewports: [viewports[0]],
      environments: [
        { name: 'english', locale: 'en-US' },
        { name: 'long-text', pseudoLocalization: {} },
      ],
      combinations: [
        { environment: 'english', viewport: 'desktop' },
        { environment: 'long-text', viewport: 'desktop' },
      ],
      journeys: [journey],
    },
    { environment: 'english' },
  );
  assert.deepEqual(
    only.results.map((result) => result.environment?.name),
    ['english'],
  );
});

test('summary rows, comparison ids and visual baselines are kept apart per environment', () => {
  const result = (environment: string | undefined): Result =>
    ({
      journey: 'finish',
      viewport: 'desktop',
      attempt: 1,
      status: 'passed',
      reason: 'ok',
      outcome: { category: 'passed' },
      quality: { verdict: 'pass' },
      steps: 1,
      durationMs: 1,
      usage: {
        planner: { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
        selector: { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      },
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
    }) as unknown as Result;
  assert.deepEqual(
    summarize([result('light'), result('dark'), result('light')]).map(
      (row) => [row.environment, row.runs],
    ),
    [
      ['light', 2],
      ['dark', 1],
    ],
  );
  assert.equal(summarize([result(undefined)])[0]!.environment, null);
  const [plain] = findingInstances(result(undefined));
  const [dark] = findingInstances(result('dark'));
  assert.equal(plain!.environment, undefined);
  assert.notEqual(plain!.id, dark!.id);
  const key = { suite: 'S', journey: 'finish', checkpoint: 'ready', viewport: 'desktop' };
  assert.equal(
    baselineDirectory('/b', { ...key, environment: 'dark' }),
    join('/b', 's', 'finish', 'ready', 'desktop@dark'),
  );
  assert.equal(baselineDirectory('/b', key), join('/b', 's', 'finish', 'ready', 'desktop'));
});
