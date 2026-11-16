// Keyboard-only journeys on the web driver: what they are offered, that they
// never fall back to the pointer, the focus transitions their key presses
// record, the keyboard.focus audit over them and a full run. Local fixture
// only (test/fixtures/keyboard.ts); deterministic decisions, no model calls.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { keyboardAuditOutput } from '../src/audits/keyboard.js';
import { candidates, check, execute, observe } from '../src/browser.js';
import {
  KEYBOARD_KEYS,
  suiteSchema,
  type Action,
  type Choice,
  type Journey,
  type Suite,
} from '../src/contracts.js';
import { keyboardTransitions } from '../src/drivers/playwright-keyboard.js';
import type { Models } from '../src/models.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';
import { readFile } from 'node:fs/promises';
import { keyboardFixture } from './fixtures/keyboard.js';

const role = (role: 'button' | 'link' | 'textbox' | 'dialog', name: string) =>
  ({ by: 'role', role, name }) as const;

const journeyConfig = {
  id: 'keyboard-settings',
  goal: 'Save the settings using only the keyboard',
  persona: 'A keyboard user',
  startPath: '/',
  allowedPaths: ['/', '/docs'],
  input: 'keyboard',
  ready: { kind: 'visible', target: role('link', 'Docs') },
  success: [
    {
      kind: 'text',
      target: { by: 'testId', value: 'status' },
      pattern: '^Saved$',
    },
  ],
  interactions: [
    {
      kind: 'fill',
      target: { by: 'label', value: 'Name' },
      value: 'Keyboard user',
      description: 'Type the name',
    },
  ],
  keyboard: {
    focusOrder: [
      role('link', 'Docs'),
      { by: 'label', value: 'Name' },
      role('button', 'Open settings'),
    ],
    dialogs: { closeOnEscape: true, restoreFocus: true },
  },
  maxSteps: 30,
  maxDurationMs: 60000,
};
const suiteFor = (url: string, extra: Record<string, unknown> = {}): Suite =>
  suiteSchema.parse({
    name: 'LOCAL keyboard fixture',
    baseURL: url,
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [journeyConfig],
    audits: { checks: [{ id: 'keyboard.focus' }] },
    ...extra,
  }) as Suite;

// Every Playwright call that is pointer input or programmatic focus, counted
// across the process: a keyboard-only journey must make none.
const pointerCalls: string[] = [];
let browser: Browser;
before(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const element = (await page.$('html'))!;
  const spy = (prototype: object, label: string, methods: string[]) => {
    for (const method of methods) {
      const target = prototype as Record<string, unknown>;
      const original = target[method];
      if (typeof original !== 'function') continue;
      target[method] = function (this: unknown, ...args: unknown[]) {
        pointerCalls.push(`${label}.${method}`);
        return (original as (...args: unknown[]) => unknown).apply(this, args);
      };
    }
  };
  const inputs = ['click', 'dblclick', 'tap', 'hover', 'focus', 'fill', 'press', 'type', 'pressSequentially', 'selectOption', 'setChecked', 'check', 'uncheck', 'dragTo', 'dragAndDrop'];
  spy(Object.getPrototypeOf(page.mouse), 'mouse', ['click', 'dblclick', 'down', 'up', 'move', 'wheel']);
  spy(Object.getPrototypeOf(page.touchscreen), 'touchscreen', ['tap']);
  spy(Object.getPrototypeOf(element), 'element', inputs);
  spy(Object.getPrototypeOf(page.locator('html')), 'locator', inputs);
  spy(Object.getPrototypeOf(page), 'page', inputs);
  await page.close();
});
after(async () => {
  await browser?.close();
});
beforeEach(() => {
  pointerCalls.length = 0;
});

async function open(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url);
  return page;
}

// Offers keys at the current state and presses `key` through the driver.
async function press(
  page: Page,
  journey: Journey,
  url: string,
  key: string,
  step = 0,
) {
  const offered = await candidates(page, journey, url);
  const action = offered.find(
    (candidate) =>
      (candidate.kind === 'key' && candidate.key === key) ||
      (key === 'fill' && candidate.kind === 'fill'),
  );
  assert.ok(action, `Expected ${key} to be offered`);
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-keyboard-'));
  await execute(
    page,
    action,
    await observe(page, step, join(directory, 'state.png')),
    journey,
    url,
  );
  return offered;
}

test('keyboard-only journeys are validated at load', () => {
  const url = 'http://127.0.0.1:1';
  assert.throws(
    () =>
      suiteFor(url, {
        journeys: [
          {
            ...journeyConfig,
            interactions: [
              {
                kind: 'click',
                target: role('button', 'Open settings'),
                description: 'Open settings',
              },
            ],
          },
        ],
      }),
    /fill and press interactions only/,
  );
  assert.throws(
    () =>
      suiteFor(url, {
        journeys: [{ ...journeyConfig, discoverRoles: ['button'] }],
      }),
    /discoverRoles/,
  );
  assert.throws(
    () =>
      suiteFor(url, {
        journeys: [{ ...journeyConfig, input: undefined }],
      }),
    /keyboard expectations need input: keyboard/,
  );
  assert.throws(
    () =>
      suiteFor(url, {
        audits: { checks: [{ id: 'keyboard.focus', at: ['ready'] }] },
      }),
    /keyboard\.focus|at/,
  );
  assert.throws(
    () =>
      suiteSchema.parse({
        name: 'native',
        platform: 'macos',
        app: { bundleId: 'com.example.app' },
        audits: { checks: [] },
        journeys: [
          {
            id: 'native-keys',
            goal: 'Press OK',
            persona: 'A keyboard user',
            input: 'keyboard',
            ready: { kind: 'focused', target: role('button', 'OK') },
            success: [{ kind: 'path', pattern: '^/$' }],
          },
        ],
      }),
    (error: Error) =>
      /web-only/.test(error.message) &&
      /focused checks apply to web suites only/.test(error.message),
  );
  const parsed = suiteFor(url);
  assert.equal(parsed.journeys[0]!.input, 'keyboard');
  assert.deepEqual(parsed.audits.checks, [
    { id: 'keyboard.focus', at: ['completion'] },
  ]);
});

test('a keyboard-only journey is offered key presses only, never links, clicks, scrolling or history', async () => {
  const app = await keyboardFixture();
  const page = await open(app.url);
  try {
    const journey = suiteFor(app.url).journeys[0]!;
    // A long page: a pointer journey would be offered wheel scrolling here.
    await page.evaluate(() => {
      document.body.style.minHeight = '4000px';
    });
    let offered = await candidates(page, journey, app.url);
    assert.deepEqual(
      offered.map((action) => (action.kind === 'key' ? action.key : action.kind)),
      [...KEYBOARD_KEYS, 'wait'],
    );
    assert.match(offered[0]!.description, /^Press Tab \(nothing focused\)$/);
    // The configured fill is offered once keys have focused its field.
    await press(page, journey, app.url, 'Tab');
    await press(page, journey, app.url, 'Tab');
    offered = await candidates(page, journey, app.url);
    assert.ok(offered.some((action) => action.kind === 'fill'));
    assert.match(offered[0]!.description, /focus on textbox "Name"/);
    await press(page, journey, app.url, 'fill');
    assert.equal(await page.inputValue('#name'), 'Keyboard user');
    assert.deepEqual(app.pointer, []);
    assert.deepEqual(pointerCalls, []);
  } finally {
    await page.close();
    await app.close();
  }
});

test('the driver refuses a pointer action in a keyboard-only journey', async () => {
  const app = await keyboardFixture();
  const page = await open(app.url);
  try {
    const journey = suiteFor(app.url).journeys[0]!;
    const before = await observe(
      page,
      0,
      join(await mkdtemp(join(tmpdir(), 'ui-ux-keyboard-')), 'state.png'),
    );
    const pointer: Action[] = [
      {
        kind: 'click',
        id: 'a0',
        target: role('button', 'Open settings'),
        description: 'Click Open settings',
      },
      {
        kind: 'link',
        id: 'a1',
        target: role('link', 'Docs'),
        description: 'Open Docs',
        href: `${app.url}/docs`,
      },
      {
        kind: 'scroll',
        id: 'a2',
        description: 'Scroll down',
        direction: 'down',
        region: 'r0',
        point: { x: 10, y: 10 },
      },
      { kind: 'back', id: 'a3', description: 'Back', url: app.url },
    ];
    for (const action of pointer)
      await assert.rejects(
        execute(page, action, before, journey, app.url),
        /Keyboard-only journey refused/,
      );
    assert.equal(await page.textContent('[data-testid=status]'), 'Idle');
    assert.deepEqual(pointerCalls, []);
  } finally {
    await page.close();
    await app.close();
  }
});

test('focus transitions from key presses report missing indicators, dialog traps, Escape and restoration', async () => {
  const app = await keyboardFixture();
  const page = await open(app.url);
  try {
    const journey = suiteFor(app.url).journeys[0]!;
    const keys = [
      'Tab', // Docs
      'Tab', // Name
      'Tab', // Open settings
      'Enter', // settings dialog, focus on Save
      'Tab', // Close settings (trapped)
      'Tab', // Save again (wraps inside)
      'Escape', // closes, focus back on Open settings
      'Tab', // Open broken dialog
      'Enter', // opens; focus stays outside
      'Escape', // does not close
      'Tab', // Silent button: out of the dialog, no indicator
      'Tab', // Hidden link: off-screen
      'Tab', // Close broken dialog
      'Enter', // closes; focus falls to the document
    ];
    for (const [step, key] of keys.entries())
      await press(page, journey, app.url, key, step);
    const transitions = keyboardTransitions(page);
    assert.equal(transitions.length, keys.length);
    assert.deepEqual(
      transitions.map((transition) => transition.to?.description ?? null),
      [
        'link "Docs"',
        'textbox "Name"',
        'button "Open settings"',
        'button "Save settings"',
        'button "Close settings"',
        'button "Save settings"',
        'button "Open settings"',
        'button "Open broken dialog"',
        'button "Open broken dialog"',
        'button "Open broken dialog"',
        'button "Silent button"',
        'link "Hidden link"',
        'button "Close broken dialog"',
        null,
      ],
    );
    // The browser's focus ring is a computed outline change; the silent
    // button suppresses it.
    assert.equal(transitions[0]!.to!.indicator, 'changed');
    assert.equal(transitions[10]!.to!.indicator, 'unchanged');
    assert.deepEqual(transitions[2]!.focusOrder, [2]);

    const output = keyboardAuditOutput(transitions, journey, 0, {
      screenshotAt: (step) => `step-${step}.png`,
    });
    assert.equal(output.complete, true);
    const rules = output.findings.map((finding) => [
      finding.ruleId,
      finding.certainty,
      finding.targets[0]!.description,
    ]);
    assert.deepEqual(rules, [
      ['dialog-initial-focus', 'violation', 'button "Open broken dialog"'],
      ['dialog-escape', 'violation', 'button "Open broken dialog"'],
      ['focus-visible', 'violation', 'button "Silent button"'],
      ['dialog-focus-trap', 'violation', 'button "Silent button"'],
      ['focus-not-shown', 'violation', 'link "Hidden link"'],
      ['dialog-focus-restore', 'violation', 'document'],
    ]);
    // The well-behaved settings dialog produced nothing; evidence points at
    // the state after the key press.
    assert.ok(output.findings.every((finding) => !/Settings/.test(finding.description)));
    assert.equal(output.findings[0]!.at!.step, 9);
    assert.equal(output.findings[0]!.at!.screenshot, 'step-9.png');
    assert.match(
      output.findings[5]!.description,
      /instead of back to button "Open broken dialog"/,
    );
    // Only transitions after `from` are reported.
    assert.deepEqual(
      keyboardAuditOutput(transitions, journey, 11, {
        screenshotAt: () => null,
      }).findings.map((finding) => finding.ruleId),
      // The broken dialog is still open when Tab leaves it again.
      ['focus-not-shown', 'dialog-focus-trap', 'dialog-focus-restore'],
    );
    // Without the explicit dialog expectations, Escape and restoration are
    // not judged.
    assert.deepEqual(
      keyboardAuditOutput(
        transitions,
        { ...journey, keyboard: { dialogs: { closeOnEscape: false, restoreFocus: false } } },
        0,
        { screenshotAt: () => null },
      ).findings.map((finding) => finding.ruleId),
      ['dialog-initial-focus', 'focus-visible', 'dialog-focus-trap', 'focus-not-shown'],
    );
    assert.deepEqual(app.pointer, []);
    assert.deepEqual(pointerCalls, []);
  } finally {
    await page.close();
    await app.close();
  }
});

test('an explicit focus order is checked against the order Tab reaches the targets', async () => {
  const app = await keyboardFixture();
  const page = await open(app.url);
  try {
    const journey = suiteSchema.parse({
      ...suiteFor(app.url),
      journeys: [
        {
          ...journeyConfig,
          keyboard: {
            focusOrder: [role('button', 'Open settings'), role('link', 'Docs')],
          },
        },
      ],
    }).journeys[0]!;
    // Docs, Name (unlisted), Open settings.
    for (const [step, key] of ['Tab', 'Tab', 'Tab'].entries())
      await press(page, journey, app.url, key, step);
    const output = keyboardAuditOutput(keyboardTransitions(page), journey, 0, {
      screenshotAt: () => null,
    });
    assert.deepEqual(
      output.findings.map((finding) => [
        finding.ruleId,
        finding.targets[0]!.description,
        finding.targets[0]!.reason,
      ]),
      [['focus-order', 'button "Open settings"', 'focusOrder[0] after focusOrder[1]']],
    );
  } finally {
    await page.close();
    await app.close();
  }
});

test('focused checks follow keyboard focus, with within for containers', async () => {
  const app = await keyboardFixture();
  const page = await open(app.url);
  try {
    const journey = suiteFor(app.url).journeys[0]!;
    for (const [step, key] of ['Tab', 'Tab', 'Tab', 'Enter'].entries())
      await press(page, journey, app.url, key, step);
    assert.equal(
      await check(page, { kind: 'focused', target: role('button', 'Save settings'), within: false }),
      true,
    );
    assert.equal(
      await check(page, { kind: 'focused', target: role('dialog', 'Settings'), within: false }),
      false,
    );
    assert.equal(
      await check(page, { kind: 'focused', target: role('dialog', 'Settings'), within: true }),
      true,
    );
    assert.equal(
      await check(page, { kind: 'focused', target: role('link', 'Docs'), within: true }),
      false,
    );
  } finally {
    await page.close();
    await app.close();
  }
});

const choice = (actions: Action[], id: string): Choice => ({
  type: 'choice',
  choice: id,
  confidence: 1,
  probabilities: Object.fromEntries([
    ...actions.map((action) => [action.id, action.id === id ? 1 : 0]),
    ['no_match', id === 'no_match' ? 1 : 0],
  ]),
});
// Presses the scripted keys in order, then answers no_match.
const scripted = (keys: string[]): Models => {
  let next = 0;
  return {
    async plan() {
      return { objective: 'Press the next key', concerns: [] };
    },
    async choose(_journey, _observation, _plan, actions) {
      const key = keys[next];
      const action = actions.find(
        (candidate) => candidate.kind === 'key' && candidate.key === key,
      );
      if (action) next++;
      return choice(actions, action?.id ?? 'no_match');
    },
  };
};

test('a keyboard-only run reaches its goal with keys, checks its declared states and never uses the pointer', async () => {
  const app = await keyboardFixture();
  try {
    const suite = suiteFor(app.url, {
      journeys: [
        {
          ...journeyConfig,
          // Saving is configured explicitly: Enter on a control named Save
          // is otherwise withheld (WEB_BLOCKED_CONTROLS).
          interactions: [
            ...journeyConfig.interactions,
            {
              kind: 'press',
              key: 'Enter',
              target: role('button', 'Save settings'),
              description: 'Save the settings',
            },
          ],
          states: [
            {
              name: 'settings-open',
              when: { kind: 'visible', target: role('dialog', 'Settings') },
              expect: [
                {
                  kind: 'focused',
                  target: role('dialog', 'Settings'),
                  within: true,
                },
              ],
            },
          ],
        },
      ],
      audits: {
        checks: [{ id: 'keyboard.focus' }, { id: 'journey.state-checks' }],
      },
    });
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-keyboard-')), 'run');
    const [result] = await runSuite(
      suite,
      scripted(['Tab', 'Tab', 'Tab', 'Enter', 'Enter']),
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    assert.equal(result!.steps, 5);
    const runs = result!.audits.runs.map((run) => [
      run.auditId,
      run.checkpoint.id,
      run.status,
    ]);
    assert.deepEqual(runs, [
      ['journey.state-checks', 'state:settings-open', 'clean'],
      ['keyboard.focus', 'completion', 'clean'],
    ]);
    assert.equal(result!.audits.runs[1]!.observations, 5);
    assert.ok(
      !result!.quality.unsupported.some((gap) => gap.id === 'keyboard.focus'),
    );
    assert.equal(result!.quality.verdict, 'pass', result!.quality.reason);
    parseResults(await readFile(join(directory, 'results.json'), 'utf8'));
    assert.deepEqual(app.pointer, []);
    assert.deepEqual(pointerCalls, []);
  } finally {
    await app.close();
  }
});

test('a goal only the pointer can reach fails a keyboard-only run without using the pointer', async () => {
  const app = await keyboardFixture();
  try {
    const suite = suiteFor(app.url, {
      journeys: [
        {
          ...journeyConfig,
          success: [
            {
              kind: 'text',
              target: { by: 'testId', value: 'status' },
              pattern: '^Pointer used$',
            },
          ],
          keyboard: undefined,
        },
      ],
    });
    const [result] = await runSuite(suite, scripted([]), {
      directory: join(await mkdtemp(join(tmpdir(), 'ui-ux-keyboard-')), 'run'),
    });
    // No scroll is offered, so no_match recovery has nothing to try.
    assert.equal(result!.outcome.code, 'selector_no_path');
    assert.equal(result!.steps, 0);
    // No key press: nothing measured, so the audit is not clean.
    assert.equal(result!.audits.runs[0]!.status, 'incomplete');
    assert.notEqual(result!.quality.verdict, 'pass');
    assert.deepEqual(app.pointer, []);
    assert.deepEqual(pointerCalls, []);
  } finally {
    await app.close();
  }
});

test('keyboard.focus does not call a pointer journey clean', () => {
  const output = keyboardAuditOutput([], { input: undefined }, 0, {
    screenshotAt: () => null,
  });
  assert.equal(output.complete, false);
  assert.match(output.detail ?? '', /keyboard-only journeys/);
});

test('keyboard.focus runs at completion by default, may run at states, and never at ready', () => {
  const at = (checks: unknown[]) =>
    suiteFor('http://127.0.0.1:1', { audits: { checks } }).audits.checks.find(
      (check) => check.id === 'keyboard.focus',
    )?.at;
  assert.deepEqual(at([{ id: 'keyboard.focus' }]), ['completion']);
  assert.deepEqual(at([{ id: 'keyboard.focus', at: ['states', 'completion'] }]), [
    'states',
    'completion',
  ]);
  // Before the journey's first key press there is no focus transition to
  // measure, so ready is refused rather than reported incomplete.
  for (const checkpoints of [['ready'], ['ready', 'completion']])
    assert.throws(
      () => at([{ id: 'keyboard.focus', at: checkpoints }]),
      (error: { issues?: { path: unknown[]; values?: unknown[] }[] }) =>
        error.issues?.some(
          (issue) =>
            issue.path.join('.') === 'audits.checks.0.at.0' &&
            JSON.stringify(issue.values) === '["states","completion"]',
        ) === true,
    );
});

// A panel that animates out on Escape and hands focus back to its opener
// only once the animation has ended, as many component libraries do.
const ANIMATED_PANEL = `<main><h1>Devices</h1><button id="open">Open panel</button>
<div id="panel" role="dialog" aria-modal="true" aria-label="Device" hidden><button id="close">Close panel</button></div></main>
<style>@keyframes out { from { opacity: 1 } to { opacity: 0 } } .closing { animation: out 400ms forwards }</style>
<script>
  const panel = document.getElementById('panel');
  const opener = document.getElementById('open');
  opener.addEventListener('click', () => { panel.hidden = false; document.getElementById('close').focus(); });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    panel.classList.add('closing');
    panel.addEventListener('animationend', () => { panel.hidden = true; panel.classList.remove('closing'); opener.focus(); }, { once: true });
  });
</script>`;

test('a key press is measured once focus settles, so a closing panel does not leave a stale observation', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const url = 'https://keyboard-settle.example';
    await page.route(`${url}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: ANIMATED_PANEL }),
    );
    await page.goto(`${url}/`);
    const journey = suiteSchema.parse({
      ...suiteFor(url),
      journeys: [{ ...journeyConfig, interactions: [], keyboard: undefined }],
    }).journeys[0]!;
    // Open panel, Enter opens the panel with focus on Close panel, Escape.
    for (const [step, key] of ['Tab', 'Enter', 'Escape'].entries())
      await press(page, journey, url, key, step);
    // Measured after the exit animation: focus is back on the opener.
    const offered = await candidates(page, journey, url);
    const tab = offered.find((action) => action.kind === 'key' && action.key === 'Tab')!;
    assert.match(tab.description, /focus on button "Open panel"/);
    // A model call later, the key still goes where the observation said.
    await page.waitForTimeout(600);
    const directory = await mkdtemp(join(tmpdir(), 'ui-ux-keyboard-'));
    await execute(
      page,
      tab,
      await observe(page, 3, join(directory, 'settled.png')),
      journey,
      url,
    );
    const escape = keyboardTransitions(page).find((entry) => entry.key === 'Escape')!;
    assert.match(escape.to?.description ?? '', /Open panel/);
  } finally {
    await page.close();
  }
});
