// fill interactions that read their value from an environment variable
// (valueEnv): validated at load, resolved only when the field is filled, and
// never copied into actions, results or the event log. Local page, scripted
// decisions, no model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
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

// A sign-in page whose field shows what was typed (type=text puts the value
// in the accessibility snapshot and in screenshots) or hides it (password).
async function signInPage(type: 'text' | 'password') {
  const html = `<!doctype html><html lang="en"><title>Sign in</title><body style="margin:0;padding:24px;font:20px sans-serif"><label>Password <input type="${type}" id="password" style="font:20px monospace;width:420px;color:#f00"></label><button type="button" id="go">Sign in</button><p data-testid="status">Signed out</p><script>document.getElementById('go').addEventListener('click', () => { document.querySelector('[data-testid=status]').textContent = document.getElementById('password').value === ${JSON.stringify(SECRET)} ? 'Signed in' : 'Wrong password'; });</script></body></html>`;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    html,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}

test('valueEnv is typed into the field but never copied into actions, decisions or results', async () => {
  const app = await signInPage('password');
  process.env[VARIABLE] = SECRET;
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-fill-env-')), 'run');
    const [result] = await runSuite(
      suite(app.url, { valueEnv: VARIABLE }),
      scriptedDecisions({ 'sign-in': ['Enter the password', 'Sign in'] }),
      { directory },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    for (const file of ['results.json', 'suite.json', 'report.html']) {
      const text = await readFile(join(directory, file), 'utf8');
      assert.ok(!text.includes(SECRET), `${file} contains the secret`);
    }
    // Actions and decisions carry the variable name only.
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
    for (const { event, data } of events)
      assert.ok(!JSON.stringify(data).includes(SECRET), `${event} contains the secret`);
    assert.ok(
      events.some(
        ({ event, data }) =>
          event === 'decision' && JSON.stringify(data).includes('"valueEnv":"UIUX_TEST_FILL_SECRET"'),
      ),
    );
  } finally {
    delete process.env[VARIABLE];
    await app.close();
  }
});

test('a valueEnv value shown on the page is redacted from every text file, masked in every screenshot, and keeps trace and video off', async () => {
  const app = await signInPage('text');
  process.env[VARIABLE] = SECRET;
  try {
    const directory = join(await mkdtemp(join(tmpdir(), 'ui-ux-fill-env-')), 'run');
    const parsed = suite(app.url, { valueEnv: VARIABLE });
    const [result] = await runSuite(
      parsed,
      scriptedDecisions({ 'sign-in': ['Enter the password', 'Sign in'] }),
      // The caller's environment does not list the variable: the fill's own
      // source is what gets redacted. --video is requested.
      { directory, env: {}, video: true },
    );
    assert.equal(result!.status, 'passed', result!.reason);
    const all = await files(directory);

    // The value reached the page (the field shows it), so the accessibility
    // snapshot of the observation after the fill held it before redaction.
    const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.match(events, /\[REDACTED:env:UIUX_TEST_FILL_SECRET\]/);
    assert.ok(
      events.split('\n').some((line) => line.includes('"observation"') && line.includes('REDACTED:env:UIUX_TEST_FILL_SECRET')),
      'an observation snapshot carried the redacted value',
    );
    for (const path of all.filter((path) => !['.png', '.zip', '.webm'].includes(extname(path))))
      assert.ok(!(await readFile(path, 'utf8')).includes(SECRET), `${path} contains the secret`);
    assert.deepEqual(result!.evidence.redactedEnv, [VARIABLE]);

    // Sensitive: neither trace nor video was captured, even with --video.
    assert.equal(result!.trace, null);
    assert.equal(result!.video, null);
    assert.ok(!all.some((path) => ['.zip', '.webm'].includes(extname(path))));
    const formats = Object.fromEntries(result!.evidence.formats.map((entry) => [entry.format, entry]));
    assert.equal(formats.trace!.enabled, false);
    assert.equal(formats.video!.enabled, false);

    // The filled field is solid mask colour in every screenshot.
    const browser = await chromium.launch();
    let box: { x: number; y: number; width: number; height: number };
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await page.setContent(app.html);
      box = (await page.locator('#password').boundingBox())!;
    } finally {
      await browser.close();
    }
    const screenshots = all.filter((path) => extname(path) === '.png');
    assert.ok(screenshots.length >= 2);
    for (const path of screenshots) {
      const image = PNG.sync.read(await readFile(path));
      let painted = 0;
      let total = 0;
      for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++)
        for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
          const index = (y * image.width + x) * 4;
          total++;
          if (image.data[index] === 255 && image.data[index + 1] === 0 && image.data[index + 2] === 255)
            painted++;
        }
      assert.ok(total > 1000);
      assert.equal(painted, total, `${path}: the filled field is not masked`);
    }
  } finally {
    delete process.env[VARIABLE];
    await app.close();
  }
});

test("a suite typing a valueEnv secret refuses an unsanitized 'local' trace or video", () => {
  for (const format of ['trace', 'video'])
    assert.throws(
      () =>
        suiteSchema.parse({
          ...suite('http://127.0.0.1:1', { valueEnv: VARIABLE }),
          evidence: { [format]: 'local' },
        }),
      new RegExp(`evidence.${format}: 'local' cannot be sanitized and this suite types a secret from fill valueEnv`),
    );
  // Without a valueEnv fill, 'local' stays allowed.
  suiteSchema.parse({ ...suite('http://127.0.0.1:1', { value: 'not secret' }), evidence: { trace: 'local' } });
});
