// Data lifecycle hooks for authorized write flows, against the local notes
// fixture (examples/notes-fixture.ts): setup before each run with a
// disposable identity, cleanup after a pass, a failure, a timeout and a
// cancellation, failed cleanups reported prominently, and repeated runs
// leaving no stored data. Scripted decisions only, no model calls.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suiteSchema, type Suite } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { reportHTML } from '../src/report.js';
import { parseResults, type Result } from '../src/results.js';
import { runSuite, type RunOptions } from '../src/runner.js';
import { exitCode } from '../src/summary.js';
import { notesFixture, type NotesFaults } from '../examples/notes-fixture.js';
import { STATE_SCRIPTS, scriptedDecisions } from '../examples/state-fixture.js';

async function notesSuite(url: string, journey: Record<string, unknown> = {}) {
  const raw = JSON.parse(
    await readFile(new URL('../examples/notes.json', import.meta.url), 'utf8'),
  );
  const local = JSON.parse(
    JSON.stringify(raw).replace(/http:\/\/127\.0\.0\.1:4174/g, url),
  );
  local.journeys[0] = { ...local.journeys[0], ...journey };
  return suiteSchema.parse(local) as Suite;
}
const decisions = () => scriptedDecisions(STATE_SCRIPTS);
const directory = async () =>
  join(await mkdtemp(join(tmpdir(), 'ui-ux-lifecycle-')), 'run');

async function withNotes(
  faults: NotesFaults,
  body: (app: Awaited<ReturnType<typeof notesFixture>>) => Promise<void>,
) {
  const app = await notesFixture(faults);
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

test('dataLifecycle only reaches a local fixture service and is web-only', async () => {
  const suite = await notesSuite('http://127.0.0.1:4174');
  assert.equal(suite.dataLifecycle?.timeoutMs, 5000);
  for (const service of [
    'https://fixtures.example.com',
    'http://10.0.0.5:8080',
    'http://user:pass@localhost:8080',
    'http://localhost:8080/api',
  ])
    assert.throws(
      () =>
        suiteSchema.parse({
          ...suite,
          dataLifecycle: { ...suite.dataLifecycle, service },
        }),
      /local fixture service/,
      service,
    );
  assert.throws(
    () => suiteSchema.parse({ ...suite, dataLifecycle: undefined }),
    /only dataLifecycle setup provides/,
  );
  assert.throws(
    () =>
      suiteSchema.parse({
        name: 'native',
        platform: 'macos',
        app: { bundleId: 'com.example.app' },
        dataLifecycle: suite.dataLifecycle,
        journeys: [
          {
            id: 'native',
            goal: 'g',
            persona: 'p',
            ready: { kind: 'path', pattern: '^/$' },
            success: [{ kind: 'path', pattern: '^/$' }],
          },
        ],
      }),
    /do not apply to macOS/,
  );
});

test('repeated write runs each get a disposable identity and leave no stored data', async () => {
  await withNotes({}, async (app) => {
    const out = await directory();
    const results = await runSuite(await notesSuite(app.url), decisions(), {
      directory: out,
      repeat: 3,
    });
    assert.deepEqual(
      results.map((result) => result.status),
      ['passed', 'passed', 'passed'],
    );
    // Reset once, then setup and cleanup around every run.
    assert.deepEqual(
      app.calls.map((call) => call.hook),
      ['reset', ...Array(3).fill(['setup', 'cleanup', 'verify']).flat()],
    );
    const runs = new Set(results.map((result) => result.dataLifecycle!.run));
    assert.equal(runs.size, 3);
    for (const result of results) {
      const data = result.dataLifecycle!;
      assert.equal(data.run, result.marker);
      assert.equal(data.setup?.status, 'ok');
      assert.deepEqual(data.values, ['owner']);
      assert.deepEqual(
        [data.cleanup?.status, data.cleanup?.trigger, data.cleanup?.remaining],
        ['ok', 'passed', 0],
      );
      assert.equal(data.clean, true);
      // Only value keys are recorded, never the values.
      assert.doesNotMatch(JSON.stringify(data), /owner-uiux/);
    }
    assert.equal(results[0]!.dataLifecycle!.reset?.status, 'ok');
    assert.equal(results[1]!.dataLifecycle!.reset?.status, 'ok');
    assert.deepEqual(app.stored(), { owners: [], notes: 0 });
    parseResults(await readFile(join(out, 'results.json'), 'utf8'));
  });
});

test('cleanup runs after a failed run and after one that ran out of steps, with the trigger that ended it', async () => {
  const never = [
    {
      kind: 'text',
      target: { by: 'testId', value: 'notes' },
      pattern: 'never shown',
    },
  ];
  // The note is saved, then the selector finds no path.
  const giveUp = (): Models => {
    const scripted = decisions();
    let calls = 0;
    return {
      plan: scripted.plan,
      async choose(...args) {
        if (++calls <= 2) return scripted.choose(...args);
        const actions = args[3];
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
    };
  };
  for (const [models, code, trigger] of [
    [giveUp(), 'selector_no_path', 'failed'],
    [decisions(), 'budget_max_steps', 'timeout'],
  ] as const)
    await withNotes({}, async (app) => {
      const [result] = await runSuite(
        await notesSuite(app.url, { success: never, maxSteps: 4 }),
        models,
        { directory: await directory() },
      );
      assert.equal(result!.outcome.code, code);
      assert.equal(result!.dataLifecycle!.cleanup?.trigger, trigger);
      assert.equal(result!.dataLifecycle!.clean, true);
      assert.ok(app.calls.some((call) => call.hook === 'cleanup'));
      assert.deepEqual(app.stored(), { owners: [], notes: 0 });
    });
});

test('cleanup runs after the journey deadline cuts a model call short', async () => {
  await withNotes({}, async (app) => {
    const scripted = decisions();
    let calls = 0;
    // The selector hangs after the note is saved, until the deadline aborts it.
    const hanging: Models = {
      plan: scripted.plan,
      async choose(...args) {
        if (++calls <= 2) return scripted.choose(...args);
        const signal = args[6];
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    };
    const [result] = await runSuite(
      await notesSuite(app.url, {
        success: [
          {
            kind: 'text',
            target: { by: 'testId', value: 'notes' },
            pattern: 'never shown',
          },
        ],
        maxDurationMs: 4000,
      }),
      hanging,
      { directory: await directory() },
    );
    assert.equal(result!.outcome.code, 'budget_deadline_abort');
    assert.deepEqual(
      [result!.dataLifecycle!.cleanup?.trigger, result!.dataLifecycle!.clean],
      ['timeout', true],
    );
    assert.deepEqual(app.stored(), { owners: [], notes: 0 });
  });
});

test('a cancelled run still cleans up and no further run starts', async () => {
  await withNotes({}, async (app) => {
    const scripted = decisions();
    const cancel = new AbortController();
    let calls = 0;
    const cancelling: Models = {
      plan: scripted.plan,
      async choose(...args) {
        // Cancel once the note is saved, while the selector is waiting.
        if (++calls === 3) {
          cancel.abort();
          const signal = args[6]!;
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw signal.reason;
        }
        return scripted.choose(...args);
      },
    };
    const options: RunOptions = {
      directory: await directory(),
      repeat: 3,
      signal: cancel.signal,
    };
    const suite = await notesSuite(app.url, {
      success: [
        {
          kind: 'text',
          target: { by: 'testId', value: 'notes' },
          pattern: 'never shown',
        },
      ],
    });
    const results = await runSuite(
      // A public owner keeps the Playwright trace on (a secret setup value
      // turns it off), so the permission pass below covers a trace too.
      suiteSchema.parse({
        ...suite,
        dataLifecycle: { ...suite.dataLifecycle, publicValues: ['owner'] },
      }),
      cancelling,
      options,
    );
    assert.equal(results.length, 1);
    const [result] = results;
    assert.deepEqual(
      [result!.status, result!.outcome.code, result!.outcome.category],
      ['error', 'run_cancelled', 'cancelled'],
    );
    assert.deepEqual(
      [result!.dataLifecycle!.cleanup?.trigger, result!.dataLifecycle!.clean],
      ['cancelled', true],
    );
    assert.equal(app.calls.filter((call) => call.hook === 'setup').length, 1);
    assert.deepEqual(app.stored(), { owners: [], notes: 0 });
    const events = await readFile(join(options.directory, 'events.jsonl'), 'utf8');
    assert.match(events, /"event":"run_cancelled"/);
    // The cancelled run's evidence, the Playwright trace included, still got
    // the final permission pass: files 0600, directories 0700.
    const walk = async (dir: string): Promise<string[]> =>
      (
        await Promise.all(
          (await readdir(dir, { withFileTypes: true })).map(async (entry) => {
            const path = join(dir, entry.name);
            assert.equal(
              (await stat(path)).mode & 0o777,
              entry.isDirectory() ? 0o700 : 0o600,
              path,
            );
            return entry.isDirectory() ? walk(path) : [path];
          }),
        )
      ).flat();
    const evidence = await walk(options.directory);
    assert.ok(evidence.some((path) => path.endsWith('trace.zip')));
  });
});

test('a failed or incomplete cleanup is reported on the result, as a finding and at the top of the report', async () => {
  // The same journey with a clean cleanup: exit 0 and the reference verdict.
  let clean!: Result;
  await withNotes({}, async (app) => {
    const [first] = await runSuite(await notesSuite(app.url), decisions(), {
      directory: await directory(),
    });
    clean = first!;
  });
  assert.equal(clean.status, 'passed', clean.reason);
  assert.equal(clean.dataLifecycle?.clean, true);
  assert.equal(exitCode([clean]), 0);
  for (const [faults, detail] of [
    [{ cleanupError: true }, /HTTP 500/],
    [{ cleanupLeavesData: true }, /2 record\(s\) of the run remain/],
  ] as const) {
    await withNotes(faults, async (app) => {
      const out = await directory();
      const [result] = await runSuite(await notesSuite(app.url), decisions(), {
        directory: out,
      });
      // The functional outcome is unchanged; the cleanup failure is separate.
      assert.equal(result!.status, 'passed');
      const data = result!.dataLifecycle!;
      assert.equal(data.clean, false);
      assert.equal(data.cleanup?.status, 'failed');
      assert.match(data.cleanup?.detail ?? '', detail);
      const finding = result!.findings.find(
        (entry) => entry.category === 'data-cleanup',
      );
      assert.match(finding?.description ?? '', /Data cleanup failed for run/);
      // The cleanup failure touches only that finding, the banner and the
      // exit code: the quality verdict and its checks are those of the same
      // run with a clean cleanup.
      assert.equal(exitCode([result!]), 1);
      assert.deepEqual(
        [result!.quality.verdict, result!.quality.executed],
        [clean.quality.verdict, clean.quality.executed],
      );
      const html = await readFile(join(out, 'report.html'), 'utf8');
      assert.match(html, /<p class="cleanup-failed" role="alert"><strong>CLEANUP FAILED<\/strong> for 1 of 1 run/);
      assert.equal(html, reportHTML((await notesSuite(app.url)).name, [result!], out));
    });
  }
});

test('a failed setup blocks the journey before it starts, and cleanup still runs', async () => {
  await withNotes({ setupError: true }, async (app) => {
    const [result] = await runSuite(await notesSuite(app.url), decisions(), {
      directory: await directory(),
    });
    assert.deepEqual(
      [result!.status, result!.outcome.code, result!.steps],
      ['blocked', 'data_setup_failed', 0],
    );
    assert.match(result!.reason, /Data setup failed: .*HTTP 500/);
    assert.equal(result!.dataLifecycle!.cleanup?.trigger, 'blocked');
    assert.deepEqual(
      app.calls.map((call) => call.hook),
      ['reset', 'setup', 'cleanup', 'verify'],
    );
  });
});

test('a journey value setup did not return blocks the run', async () => {
  await withNotes({}, async (app) => {
    const [result] = await runSuite(
      await notesSuite(app.url, { startPath: '/notes?owner={{data.missing}}' }),
      decisions(),
      { directory: await directory() },
    );
    assert.equal(result!.outcome.code, 'data_setup_failed');
    assert.match(result!.reason, /\{\{data\.missing\}\} but setup returned no missing/);
    assert.equal(result!.dataLifecycle!.clean, true);
  });
});
