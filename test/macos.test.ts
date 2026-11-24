import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import {
  DEFAULT_BLOCKED_CONTROLS,
  suiteSchema,
  type Action,
} from '../src/contracts.js';
import { ensureHelper } from '../src/drivers/macos.js';
import {
  buildFixtureApp,
  FIXTURE_BUNDLE_ID,
} from '../src/drivers/macos-fixture.js';
import type { Models } from '../src/models.js';
import { parseResults } from '../src/results.js';
import { runSuite } from '../src/runner.js';

// Native tests need macOS plus Accessibility and Screen Recording permission
// for the process running them; elsewhere (CI on Linux) they are skipped.
async function nativeReady(): Promise<string | false> {
  if (process.platform !== 'darwin') return 'not macOS';
  const helper = await ensureHelper();
  const status = JSON.parse(
    execFileSync(helper, { input: '{"cmd":"status"}\n' }).toString().trim(),
  );
  return status.accessibility && status.screenCapture
    ? false
    : 'Accessibility or Screen Recording permission missing';
}
const skip = await nativeReady();

const suite = (app: string) =>
  suiteSchema.parse({
    name: 'Native fixture',
    platform: 'macos',
    app: { bundleId: FIXTURE_BUNDLE_ID, path: app, relaunch: true },
    viewports: [{ name: 'window', width: 900, height: 600 }],
    journeys: [
      {
        id: 'open-atlas',
        goal: 'Open the Atlas project',
        persona: 'A designer',
        ready: {
          kind: 'visible',
          target: { by: 'testId', value: 'nav-projects' },
        },
        success: [
          { kind: 'path', pattern: '^/Project Atlas$' },
          {
            kind: 'text',
            target: { by: 'testId', value: 'project-title' },
            pattern: '^Atlas$',
          },
        ],
        maxSteps: 12,
        maxDurationMs: 60000,
      },
    ],
  });

test(
  'a native app journey runs end to end through the macOS driver',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-')),
      'run',
    );
    const offeredDescriptions: string[] = [];
    const pick = (actions: Action[]) =>
      actions.find((action) => action.description === 'Press button Atlas') ??
      actions.find(
        (action) =>
          action.description === 'Press button Projects' &&
          !actions.some((other) => other.kind === 'scroll'),
      ) ??
      actions.find(
        (action) => action.kind === 'scroll' && action.direction === 'down',
      );
    const models: Models = {
      async plan() {
        return { objective: 'Open Projects, then Atlas', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        offeredDescriptions.push(
          ...actions.map((action) => action.description),
        );
        const choice = pick(actions)?.id ?? 'no_match';
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', choice === 'no_match' ? 1 : 0],
          ]),
        };
      },
    };
    const [result] = await runSuite(suite(app), models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    assert.deepEqual(result!.checks, [true, true]);
    // The real native driver produces a valid version-2 result: the outcome
    // is decided by the assertions, and the quality verdict stays
    // not_evaluated because no built-in quality check runs on macOS.
    const [stored] = parseResults(
      await readFile(join(directory, 'results.json'), 'utf8'),
    );
    assert.equal(stored!.outcome.code, 'assertions_passed');
    assert.equal(stored!.outcome.source, 'assertion');
    assert.equal(stored!.quality.verdict, 'not_evaluated');
    assert.deepEqual(stored!.quality.executed, []);
    assert.ok(
      !stored!.quality.unsupported.some(
        (gap) => gap.id === 'layout.horizontal-overflow',
      ),
    );
    assert.deepEqual(stored!.audits.runs, []);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const actions = events
      .filter((event) => event.event === 'action_result')
      .map((event) => [event.data.action.description, event.data.error]);
    assert.equal(actions[0]![0], 'Press button Projects');
    assert.ok(
      actions.some(([description]) =>
        String(description).startsWith('Scroll down in Project list'),
      ),
    );
    assert.deepEqual(actions.at(-1), ['Press button Atlas', null]);
    // Atlas is only offered once scrolled into the visible list area.
    assert.ok(
      offeredDescriptions.indexOf('Press button Atlas') >
        offeredDescriptions.indexOf('Press button Apollo'),
    );
    assert.ok(result!.trace?.endsWith('.json'));
    const screenshot = await readFile(
      join(directory, 'open-atlas-window', 'final.png'),
    );
    assert.ok(screenshot.length > 1000);
  },
);

test(
  'destructive controls are never offered in native apps',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-block-')),
      'run',
    );
    const seen: string[] = [];
    const models: Models = {
      async plan() {
        return { objective: 'Open Settings', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        seen.push(...actions.map((action) => action.description));
        const choice =
          actions.find(
            (action) => action.description === 'Press button Settings',
          )?.id ?? actions.find((action) => action.kind === 'wait')!.id;
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', 0],
          ]),
        };
      },
    };
    const blocked = suiteSchema.parse({
      ...suite(app),
      journeys: [{ ...suite(app).journeys[0]!, maxSteps: 3 }],
    });
    await runSuite(blocked, models, { directory });
    assert.ok(seen.includes('Press checkbox Compact layout'));
    assert.ok(!seen.some((description) => /Delete all data/.test(description)));
    const skipped = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.event === 'candidate_skipped' &&
          event.data.reason === 'blocked',
      )
      .map((event) => event.data.name);
    assert.ok(skipped.includes('Delete all data'));
  },
);

test(
  'scrolling a SwiftUI list advances page by page in a compact window',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-compact-')),
      'run',
    );
    const compact = suiteSchema.parse({
      ...suite(app),
      viewports: [{ name: 'compact', width: 640, height: 480 }],
    });
    const models: Models = {
      async plan() {
        return { objective: 'Open Projects, then Atlas', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        const choice = (actions.find(
          (action) => action.description === 'Press button Atlas',
        ) ??
          actions.find(
            (action) => action.kind === 'scroll' && action.direction === 'down',
          ) ??
          actions.find(
            (action) => action.description === 'Press button Projects',
          ))!.id;
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', 0],
          ]),
        };
      },
    };
    const [result] = await runSuite(compact, models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const positions = events
      .filter(
        (event) =>
          event.event === 'observation' && event.data.url.endsWith('/Projects'),
      )
      .map((event) => event.data.scroll.containers[0]?.y ?? 0);
    // Each scroll moved further down; none jumped back to the top.
    assert.ok(positions.length >= 3);
    for (let index = 1; index < positions.length; index++)
      assert.ok(
        positions[index] > positions[index - 1],
        JSON.stringify(positions),
      );
  },
);

test(
  'list rows are offered as selections and selecting one changes the app',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-rows-')),
      'run',
    );
    const themes = suiteSchema.parse({
      ...suite(app),
      journeys: [
        {
          ...suite(app).journeys[0]!,
          id: 'dark-theme',
          goal: 'Switch to the Dark theme',
          success: [
            {
              kind: 'text',
              target: { by: 'testId', value: 'theme-current' },
              pattern: '^Theme: Dark$',
            },
          ],
        },
      ],
    });
    const offered: string[][] = [];
    const models: Models = {
      async plan() {
        return { objective: 'Open Settings and choose Dark', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        offered.push(actions.map((action) => action.description));
        const choice = (actions.find(
          (action) => action.description === 'Select row Dark',
        ) ??
          actions.find(
            (action) => action.description === 'Press button Settings',
          ))!.id;
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', 0],
          ]),
        };
      },
    };
    const [result] = await runSuite(themes, models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    const settings = offered.find((list) => list.includes('Select row Dark'))!;
    // The selected row (Light) is not offered; the others are.
    assert.ok(settings.includes('Select row Solarized'));
    assert.ok(!settings.includes('Select row Light'));
  },
);

test('file side effects such as Save are blocked by default', () => {
  const save = new RegExp(
    DEFAULT_BLOCKED_CONTROLS.find((pattern) => pattern.includes('save'))!,
    'i',
  );
  for (const name of [
    'Save',
    'Save As…',
    'Export as PDF',
    'Rename…',
    'Move To…',
    'Duplicate',
  ])
    assert.ok(save.test(name), name);
  // Harmless names stay offered ("Saved" is not the word "save").
  for (const name of ['Bold', 'align center', 'Saved searches'])
    assert.ok(!save.test(name), name);
  // "Format" (a menu or a formatting button) is not blocked; formatting a disk is.
  const blocked = DEFAULT_BLOCKED_CONTROLS.map(
    (pattern) => new RegExp(pattern, 'i'),
  );
  assert.ok(!blocked.some((pattern) => pattern.test('Format')));
  assert.ok(blocked.some((pattern) => pattern.test('Format Disk…')));
});

test(
  'menu commands are opt-in, safe ones work, risky ones are never offered',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-menus-')),
      'run',
    );
    const viaMenu = suiteSchema.parse({
      ...suite(app),
      menus: true,
      journeys: [
        {
          ...suite(app).journeys[0]!,
          id: 'settings-menu',
          goal: 'Open Settings from the menu bar',
          success: [{ kind: 'path', pattern: '^/Settings$' }],
          maxSteps: 3,
        },
      ],
    });
    let offered: string[] = [];
    const models: Models = {
      async plan() {
        return { objective: 'Use the Navigate menu', concerns: [] };
      },
      async choose(_j, _o, _p, actions) {
        offered = actions.map((action) => action.description);
        const choice = actions.find(
          (action) =>
            action.description === 'Choose menu Navigate › Show Settings',
        )!.id;
        return {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries([
            ...actions.map((action) => [
              action.id,
              action.id === choice ? 1 : 0,
            ]),
            ['no_match', 0],
          ]),
        };
      },
    };
    const [result] = await runSuite(viaMenu, models, { directory });
    assert.equal(result!.status, 'passed', result!.reason);
    const menus = offered.filter((description) =>
      description.startsWith('Choose menu '),
    );
    assert.ok(menus.length > 0);
    for (const risky of [
      /Erase/,
      /Open Library/,
      /Quit/,
      /Hide/,
      /Close/,
      /Full Screen/i,
      /^Choose menu (Window|Help) /,
      /Services/,
      /About This Mac|Restart|Shut Down|Log Out/,
      /Dictation/,
      /Emoji/,
    ])
      assert.ok(
        !menus.some((description) => risky.test(description)),
        `${risky} offered: ${menus.join(', ')}`,
      );
    const skipped = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.event === 'candidate_skipped' && event.data.role === 'menuitem',
      )
      .map((event) => event.data.name);
    assert.ok(skipped.includes('Navigate › Erase Everything'));
    assert.ok(skipped.includes('Navigate › Open Library…'));
    // Without the opt-in, no menu commands are offered.
    const off = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-nomenus-')),
      'run',
    );
    await runSuite(
      suiteSchema.parse({
        ...viaMenu,
        menus: false,
        journeys: [{ ...viaMenu.journeys[0]!, maxSteps: 1 }],
      }),
      {
        ...models,
        async choose(_j, _o, _p, actions) {
          offered = actions.map((action) => action.description);
          return {
            type: 'choice',
            choice: 'no_match',
            confidence: 1,
            probabilities: Object.fromEntries([
              ...actions.map((action) => [action.id, 0]),
              ['no_match', 1],
            ]),
          };
        },
      },
      { directory: off },
    );
    assert.ok(
      !offered.some((description) => description.startsWith('Choose menu ')),
    );
  },
);

test('menus is rejected for web suites', () => {
  assert.throws(
    () =>
      suiteSchema.parse({
        name: 'Web',
        baseURL: 'https://app.example',
        menus: true,
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        journeys: [
          {
            id: 'j',
            goal: 'g',
            persona: 'p',
            startPath: '/',
            allowedPaths: ['/'],
            ready: { kind: 'path', pattern: '.*' },
            success: [{ kind: 'path', pattern: '^/x$' }],
          },
        ],
      }),
    /menus applies to macOS suites only/,
  );
});

test('controls that stop, pause or install system software are blocked by default', () => {
  const blocked = DEFAULT_BLOCKED_CONTROLS.map(
    (pattern) => new RegExp(pattern, 'i'),
  );
  for (const name of [
    'Stop Defender',
    'Install Update 0.5.72…',
    'Pause sync',
    'Disconnect',
    'Unlink device',
    'Upgrade now',
  ])
    assert.ok(
      blocked.some((pattern) => pattern.test(name)),
      name,
    );
  for (const name of ['Settings', 'Home', 'Open Claude Desktop'])
    assert.ok(!blocked.some((pattern) => pattern.test(name)), name);
});

test(
  'label targets match visible static text in native apps',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-label-')),
      'run',
    );
    const labelled = suiteSchema.parse({
      ...suite(app),
      journeys: [
        {
          ...suite(app).journeys[0]!,
          id: 'inbox-label',
          success: [
            {
              kind: 'anyVisible',
              target: { by: 'label', value: 'No new messages' },
            },
          ],
          maxSteps: 1,
        },
      ],
    });
    const [result] = await runSuite(
      labelled,
      {
        async plan() {
          return { objective: 'none', concerns: [] };
        },
        async choose() {
          throw new Error('not reached: the Inbox already shows the label');
        },
      },
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    assert.equal(result!.steps, 0);
  },
);

// Picks the first offered action matching `want`, in order; no_match otherwise.
const scripted = (want: ((action: Action) => boolean)[]): Models => ({
  async plan() {
    return { objective: 'Follow the scripted steps', concerns: [] };
  },
  async choose(_j, _o, _p, actions) {
    const choice =
      want.map((match) => actions.find(match)).find(Boolean)?.id ?? 'no_match';
    return {
      type: 'choice',
      choice,
      confidence: 1,
      probabilities: Object.fromEntries([
        ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
        ['no_match', choice === 'no_match' ? 1 : 0],
      ]),
    };
  },
});

const inboxSuite = (app: string, journey: Record<string, unknown>) =>
  suiteSchema.parse({
    name: 'Native fixture, inbox',
    platform: 'macos',
    app: { bundleId: FIXTURE_BUNDLE_ID, path: app, relaunch: true },
    viewports: [{ name: 'window', width: 900, height: 600 }],
    journeys: [
      {
        persona: 'A reader',
        ready: {
          kind: 'visible',
          target: { by: 'testId', value: 'inbox-empty' },
        },
        maxSteps: 4,
        maxDurationMs: 60000,
        ...journey,
      },
    ],
  });

test(
  'a control without AXPress is never offered, even as a configured click',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const offered: Action[] = [];
    const models = scripted([
      (action) =>
        'target' in action &&
        action.target.by === 'testId' &&
        action.target.value === 'click-only',
    ]);
    const choose = models.choose.bind(models);
    models.choose = async (...args) => {
      offered.push(...args[3]);
      return choose(...args);
    };
    const directory = join(
      await mkdtemp(join(tmpdir(), 'ui-ux-macos-')),
      'run',
    );
    const [result] = await runSuite(
      inboxSuite(app, {
        id: 'mark-read',
        goal: 'Mark all messages read',
        // The suite even configures the click: it still has no accessibility
        // action, so it would need a synthesized mouse event.
        interactions: [
          {
            kind: 'click',
            target: { by: 'testId', value: 'click-only' },
            description: 'Mark all read',
          },
        ],
        success: [
          { kind: 'visible', target: { by: 'testId', value: 'marked-read' } },
        ],
        maxSteps: 1,
      }),
      models,
      { directory },
    );
    assert.notEqual(result!.status, 'passed', result!.reason);
    // Not offering a control is a driver policy, not a product defect or a
    // harness failure: the selector ran out of steps without the outcome.
    assert.equal(result!.outcome.code, 'budget_max_steps');
    assert.notEqual(result!.outcome.source, 'assertion');
    assert.ok(offered.length > 0, 'the selector saw the offered actions');
    assert.ok(
      !offered.some(
        (action) =>
          action.description.includes('Mark all read') ||
          ('target' in action &&
            action.target.by === 'testId' &&
            action.target.value === 'click-only'),
      ),
      offered.map((action) => action.description).join(', '),
    );
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (event) =>
          event.event === 'candidate_skipped' &&
          event.data.reason === 'no_accessibility_action' &&
          event.data.name === 'Mark all read',
      ),
      'the skipped click is logged with its reason',
    );
    // Accessibility-offered controls are still there: the inbox navigation.
    assert.ok(
      offered.some((action) => action.description === 'Press button Projects'),
    );
  },
);

test('press interactions and syntheticInput are rejected for macOS suites', () => {
  const press = {
    id: 'p',
    goal: 'g',
    persona: 'p',
    ready: { kind: 'path', pattern: '.' },
    success: [{ kind: 'path', pattern: '.' }],
    interactions: [
      {
        kind: 'press',
        target: { by: 'testId', value: 'x' },
        key: 'Enter',
        description: 'Submit',
      },
    ],
  };
  const macos = {
    name: 'n',
    platform: 'macos',
    app: { bundleId: 'com.example.app' },
    viewports: [{ name: 'w', width: 800, height: 600 }],
  };
  assert.throws(
    () => suiteSchema.parse({ ...macos, journeys: [press] }),
    /press interactions are not supported on macOS: the driver never synthesizes keyboard input/,
  );
  assert.throws(
    () =>
      suiteSchema.parse({
        ...macos,
        journeys: [{ ...press, interactions: [], setup: press.interactions }],
      }),
    /press interactions are not supported on macOS/,
  );
  // There is no switch to allow synthesized input.
  assert.throws(
    () =>
      suiteSchema.parse({
        ...macos,
        syntheticInput: true,
        journeys: [{ ...press, interactions: [] }],
      }),
    /syntheticInput/,
  );
  // Web suites keep press: Playwright sends keys inside the browser page.
  assert.doesNotThrow(() =>
    suiteSchema.parse({
      name: 'n',
      baseURL: 'https://example.com',
      viewports: [{ name: 'd', width: 800, height: 600 }],
      journeys: [{ ...press, startPath: '/', allowedPaths: ['/'] }],
    }),
  );
});

test(
  'the scope probe follows the app process and its on-screen window',
  { skip },
  async () => {
    const app = await buildFixtureApp();
    const helper = spawn(await ensureHelper(), [], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const replies: ((reply: Record<string, unknown>) => void)[] = [];
    createInterface({ input: helper.stdout! }).on('line', (line) =>
      replies.shift()!(JSON.parse(line)),
    );
    const call = (request: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        replies.push(resolve);
        helper.stdin!.write(JSON.stringify(request) + '\n');
      });
    try {
      await call({ cmd: 'terminate', bundleId: FIXTURE_BUNDLE_ID });
      const { pid } = await call({ cmd: 'launch', path: app });
      let probe: Record<string, unknown> = {};
      for (let i = 0; i < 50 && probe.alive !== true; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        probe = await call({ cmd: 'alive', pid });
      }
      assert.equal(probe.alive, true, JSON.stringify(probe));
      assert.equal(probe.running, true);
      await call({ cmd: 'terminate', bundleId: FIXTURE_BUNDLE_ID });
      probe = await call({ cmd: 'alive', pid });
      assert.deepEqual(
        [probe.alive, probe.running],
        [false, false],
        JSON.stringify(probe),
      );
      // A pid with no process is never in scope.
      probe = await call({ cmd: 'alive', pid: 99999 });
      assert.equal(probe.running, false);
    } finally {
      helper.stdin!.end();
    }
  },
);
