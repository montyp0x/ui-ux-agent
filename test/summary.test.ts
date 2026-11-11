import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { suiteSchema, type Result } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { evaluateQuality } from '../src/quality.js';
import {
  OUTCOME_CODES,
  RESULT_VERSION,
  emptySignals,
  type OutcomeCode,
} from '../src/results.js';
import { emptyAudits } from '../src/audits/contract.js';
import { runSuite } from '../src/runner.js';
import { addModelCall, emptyUsage, summarize } from '../src/summary.js';

const CODES: Record<Result['status'], OutcomeCode> = {
  passed: 'assertions_passed',
  failed: 'budget_max_steps',
  blocked: 'ready_not_reached',
  error: 'model_call_failed',
};
const run = (
  status: Result['status'],
  steps: number,
  durationMs: number,
  viewport = 'desktop',
  reason = status === 'passed' ? 'ok' : 'Task budget exhausted',
  observations = 1,
): Result => {
  const [, category, source] = OUTCOME_CODES[CODES[status]];
  return {
    resultVersion: RESULT_VERSION,
    journey: 'find',
    viewport,
    attempt: 1,
    usage: emptyUsage(),
    status,
    reason,
    outcome: {
      code: CODES[status],
      category,
      source,
      stage: 'observe',
      step: 0,
      detail: null,
      evidence: { screenshot: null, events: [], failedChecks: [] },
      signals: emptySignals(),
    },
    quality: evaluateQuality({
      platform: 'web',
      observations,
      findings: [],
      policyBlocks: 0,
      evidenceComplete: true,
    }),
    steps,
    durationMs,
    checks: [],
    findings: [],
    audits: emptyAudits(),
    trace: 't',
    video: null,
  };
};

test('summaries group by journey and viewport with pass rate, reasons and medians', () => {
  const [desktop, narrow] = summarize([
    run('passed', 4, 1000),
    run('failed', 20, 9000),
    run('passed', 6, 3000),
    run('failed', 10, 5000, 'narrow'),
    run('error', 2, 1000, 'narrow', 'Model HTTP 500'),
  ]);
  assert.deepEqual(
    [
      desktop!.passed,
      desktop!.runs,
      desktop!.medianSteps,
      desktop!.medianDurationMs,
    ],
    [2, 3, 6, 3000],
  );
  assert.deepEqual(desktop!.reasons, { 'Task budget exhausted': 1 });
  assert.deepEqual(narrow!.statuses, {
    passed: 0,
    failed: 1,
    blocked: 0,
    error: 1,
  });
  assert.equal(narrow!.medianSteps, 6);
  assert.deepEqual(narrow!.reasons, {
    'Task budget exhausted': 1,
    'Model HTTP 500': 1,
  });
  assert.deepEqual(desktop!.categories, { budget_exhausted: 1 });
  assert.deepEqual(narrow!.categories, {
    budget_exhausted: 1,
    model_error: 1,
  });
});

test('summaries count quality verdicts apart from the functional outcome', () => {
  const [row] = summarize([
    run('passed', 4, 1000),
    run('passed', 4, 1000, 'desktop', 'ok', 0),
    run('failed', 4, 1000, 'desktop', 'Task budget exhausted', 0),
  ]);
  assert.equal(row!.passed, 2);
  // A run with no observed state has no executed checks: never a pass.
  assert.deepEqual(row!.quality, { pass: 1, fail: 0, not_evaluated: 2 });
});

test('model usage reads OpenAI-style and input/output token fields', () => {
  const usage = emptyUsage();
  addModelCall(usage, {
    role: 'planner',
    durationMs: 3000,
    response: { usage: { prompt_tokens: 1200, completion_tokens: 80 } },
  });
  addModelCall(usage, {
    role: 'selector',
    durationMs: 400,
    response: { usage: { input_tokens: 300, output_tokens: 5 } },
  });
  addModelCall(usage, { role: 'selector', durationMs: 100, response: {} });
  addModelCall(usage, { unrelated: true });
  assert.deepEqual(usage, {
    planner: {
      calls: 1,
      durationMs: 3000,
      inputTokens: 1200,
      outputTokens: 80,
    },
    selector: { calls: 2, durationMs: 500, inputTokens: 300, outputTokens: 5 },
  });
});

test('--repeat runs each journey several times with separate evidence and per-run usage', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      request.url === '/done'
        ? '<h1>Done</h1>'
        : '<h1>Start</h1><a href="/done">Finish</a>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-repeat-')), 'run');
  const models = (
    log: (event: string, data: unknown) => Promise<void>,
  ): Models => ({
    async plan() {
      await log('model_call', {
        role: 'planner',
        model: 'fixture',
        durationMs: 10,
        response: { usage: { prompt_tokens: 100, completion_tokens: 10 } },
      });
      return { objective: 'Finish', concerns: [] };
    },
    async choose(_j, _o, _p, actions) {
      await log('model_call', {
        role: 'selector',
        model: 'fixture',
        durationMs: 5,
        response: { usage: { input_tokens: 50, output_tokens: 1 } },
      });
      const choice = actions.find((action) => action.kind === 'link')!.id;
      return {
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: Object.fromEntries([
          ...actions.map((action) => [action.id, action.id === choice ? 1 : 0]),
          ['no_match', 0],
        ]),
      };
    },
  });
  try {
    const results = await runSuite(
      suiteSchema.parse({
        name: 'Repeat fixture',
        baseURL: `http://127.0.0.1:${address.port}`,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        journeys: [
          {
            id: 'finish',
            goal: 'Finish',
            persona: 'Visitor',
            startPath: '/',
            allowedPaths: ['/', '/done'],
            ready: { kind: 'path', pattern: '.*' },
            success: [{ kind: 'path', pattern: '^/done$' }],
          },
        ],
      }),
      models,
      { directory, repeat: 3 },
    );
    assert.deepEqual(
      results.map((result) => [result.attempt, result.status]),
      [
        [1, 'passed'],
        [2, 'passed'],
        [3, 'passed'],
      ],
    );
    // Each run counts only its own calls.
    for (const result of results)
      assert.deepEqual(result.usage, {
        planner: {
          calls: 1,
          durationMs: 10,
          inputTokens: 100,
          outputTokens: 10,
        },
        selector: { calls: 1, durationMs: 5, inputTokens: 50, outputTokens: 1 },
      });
    for (const attempt of [1, 2, 3])
      assert.ok(
        (
          await stat(join(directory, `finish-desktop-${attempt}`))
        ).isDirectory(),
      );
    const [summary] = JSON.parse(
      await readFile(join(directory, 'summary.json'), 'utf8'),
    );
    assert.deepEqual(
      [summary.passed, summary.runs, summary.tokens, summary.modelCalls],
      [3, 3, { input: 450, output: 33 }, { planner: 3, selector: 3 }],
    );
    const report = await readFile(join(directory, 'report.html'), 'utf8');
    assert.match(report, /<td>3\/3<\/td>/);
    assert.match(report, /run 3/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the CLI rejects an invalid --repeat before running anything', async () => {
  const failure = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.ts',
      '--suite',
      'examples/website.json',
      '--repeat',
      '0',
    ],
    { env: { ...process.env, PLANNER_API_KEY: 'x', JEV_API_KEY: 'x' } },
  ).catch((error: { code: number; stderr: string }) => error);
  assert.ok('code' in failure);
  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /repeat must be an integer from 1 to 50/);
});
