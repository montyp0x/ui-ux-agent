// fill interactions that read their value from an environment variable
// (valueEnv): validated at load, resolved only when the field is filled, and
// never copied into actions, results or the event log. Local page, scripted
// decisions, no model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillValue, missingFillEnv, suiteSchema } from '../src/contracts.js';
import { runSuite } from '../src/runner.js';
import { scriptedDecisions } from '../examples/state-fixture.js';

const SECRET = 'correct horse battery staple';
const VARIABLE = 'UIUX_TEST_FILL_SECRET';

const journey = (fill: Record<string, unknown>) => ({
  id: 'sign-in',
  goal: 'Sign in',
  persona: 'A returning user',
  startPath: '/',
  allowedPaths: ['/'],
  ready: { kind: 'visible', target: { by: 'role', role: 'button', name: 'Sign in' } },
  success: [{ kind: 'text', target: { by: 'testId', value: 'status' }, pattern: '^Signed in$' }],
  interactions: [
    { kind: 'fill', target: { by: 'label', value: 'Password' }, description: 'Enter the password', ...fill },
    { kind: 'click', target: { by: 'role', role: 'button', name: 'Sign in' }, description: 'Sign in' },
  ],
  maxSteps: 6,
});
const suite = (url: string, fill: Record<string, unknown>) =>
  suiteSchema.parse({
    name: 'LOCAL fill valueEnv',
    baseURL: url,
    viewports: [{ name: 'desktop', width: 1024, height: 768 }],
    journeys: [journey(fill)],
  });

test('a fill takes exactly one of value or valueEnv, a variable name', () => {
  const url = 'http://127.0.0.1:1';
  assert.throws(() => suite(url, {}), /exactly one of value or valueEnv/);
  assert.throws(
    () => suite(url, { value: 'x', valueEnv: VARIABLE }),
    /exactly one of value or valueEnv/,
  );
  assert.throws(() => suite(url, { valueEnv: 'NOT-A-NAME' }), /environment variable name/);
  const parsed = suite(url, { valueEnv: VARIABLE });
  const fill = parsed.journeys[0]!.interactions[0]!;
  assert.deepEqual(
    fillValue(fill as { description: string; valueEnv: string }, { [VARIABLE]: SECRET }),
    SECRET,
  );
  assert.throws(
    () => fillValue(fill as { description: string; valueEnv: string }, {}),
    /"Enter the password" reads its value from the environment variable UIUX_TEST_FILL_SECRET, which is not set/,
  );
  assert.deepEqual(missingFillEnv(parsed, {}), [VARIABLE]);
  assert.deepEqual(missingFillEnv(parsed, { [VARIABLE]: '' }), []);
});

test('an unset valueEnv stops the suite before any run starts', async () => {
  delete process.env[VARIABLE];
  const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-fill-env-')), 'run');
  await assert.rejects(
    runSuite(suite('http://127.0.0.1:1', { valueEnv: VARIABLE }), scriptedDecisions({}), {
      directory,
    }),
    /Set the environment variable UIUX_TEST_FILL_SECRET read by fill valueEnv/,
  );
  await assert.rejects(readdir(directory));
});

test('valueEnv is typed into the field but never copied into actions, decisions or results', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html lang="en"><title>Sign in</title><label>Password <input type="password" id="password"></label><button type="button" id="go">Sign in</button><p data-testid="status">Signed out</p><script>document.getElementById('go').addEventListener('click', () => { document.querySelector('[data-testid=status]').textContent = document.getElementById('password').value === ${JSON.stringify(SECRET)} ? 'Signed in' : 'Wrong password'; });</script></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  process.env[VARIABLE] = SECRET;
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-fill-env-')), 'run');
    const [result] = await runSuite(
      suite(`http://127.0.0.1:${address.port}`, { valueEnv: VARIABLE }),
      scriptedDecisions({ 'sign-in': ['Enter the password', 'Sign in'] }),
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    for (const file of ['results.json', 'suite.json', 'report.html']) {
      const text = await readFile(join(directory, file), 'utf8');
      assert.ok(!text.includes(SECRET), `${file} contains the secret`);
    }
    // Actions and decisions carry the variable name only. The page's own
    // accessibility snapshot of the filled field is page evidence (observation
    // events, traces): redacting it is the evidence redactor's job, so it is
    // the only place the value may appear, and the model never receives it.
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
    for (const { event, data } of events) {
      const { snapshot: _snapshot, ...rest } = data;
      assert.ok(!JSON.stringify(rest).includes(SECRET), `${event} contains the secret`);
      if (!['observation', 'content_observation'].includes(event))
        assert.ok(!JSON.stringify(data).includes(SECRET), `${event} contains the secret`);
    }
    assert.ok(
      events.some(
        ({ event, data }) =>
          event === 'decision' && JSON.stringify(data).includes('"valueEnv":"UIUX_TEST_FILL_SECRET"'),
      ),
    );
  } finally {
    delete process.env[VARIABLE];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
