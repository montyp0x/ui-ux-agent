import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  dedicatedProfile,
  PROFILE_MARKER,
  scopeStorageState,
  suiteOrigins,
} from '../src/auth.js';
import { suiteSchema } from '../src/contracts.js';
import type { Models } from '../src/models.js';
import { runSuite } from '../src/runner.js';
import { isPrivate } from '../src/evidence/private.js';

const cookie = (name: string, domain: string) => ({
  name,
  value: 'v',
  domain,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: 'Lax',
});

const state = {
  cookies: [
    cookie('session', 'app.example.com'),
    cookie('edge', '.example.com'),
    cookie('api', 'api.example.net'),
    cookie('sso', '.accounts.idp.test'),
    cookie('lookalike', 'evil-example.com'),
  ],
  origins: [
    {
      origin: 'https://app.example.com',
      localStorage: [{ name: 't', value: '1' }],
    },
    { origin: 'https://other.test', localStorage: [{ name: 'x', value: '2' }] },
  ],
};

test('session scoping keeps only cookies and storage for the suite origins', () => {
  const { state: scoped, report } = scopeStorageState(state, [
    'https://app.example.com',
    'https://api.example.net',
  ]);
  assert.deepEqual(
    scoped.cookies.map((entry) => entry.name),
    ['session', 'edge', 'api'],
  );
  assert.deepEqual(report.droppedCookies, {
    'accounts.idp.test': 1,
    'evil-example.com': 1,
  });
  assert.deepEqual(report.keptOrigins, ['https://app.example.com']);
  assert.deepEqual(report.droppedOrigins, ['https://other.test']);
  // Cookie fields Playwright wrote survive the round trip.
  assert.equal((scoped.cookies[0] as Record<string, unknown>).sameSite, 'Lax');
});

test('suite origins include navigation, backend and request-rule origins', () => {
  const suite = suiteSchema.parse({
    name: 'Origins',
    baseURL: 'https://app.example.com/start',
    allowedOrigins: ['https://docs.example.com'],
    applicationOrigins: ['https://api.example.net'],
    readOnlyPosts: [{ origin: 'https://search.example.net', path: '/q' }],
    viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    journeys: [
      {
        id: 'j',
        goal: 'g',
        persona: 'p',
        startPath: '/',
        allowedPaths: ['/'],
        ready: { kind: 'path', pattern: '.*' },
        success: [{ kind: 'path', pattern: '^/done$' }],
      },
    ],
  });
  assert.deepEqual(suiteOrigins(suite), [
    'https://app.example.com',
    'https://docs.example.com',
    'https://api.example.net',
    'https://search.example.net',
  ]);
});

test('--login --from writes a scoped, owner-only session file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-login-'));
  const source = join(directory, 'full.json');
  const out = join(directory, '.auth', 'app.json');
  await writeFile(source, JSON.stringify(state));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.ts',
      '--suite',
      'examples/website.json',
      '--url',
      'https://app.example.com',
      '--login',
      out,
      '--from',
      source,
    ],
    { env: { ...process.env } },
  );
  assert.match(stdout, /dropped 3 cookies/);
  assert.doesNotMatch(stdout, /"value"/);
  assert.ok(await isPrivate(out, 'file'), `${out} is not private`);
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(
    saved.cookies.map((entry: { name: string }) => entry.name),
    ['session', 'edge'],
  );
});

test('runs load the scoped session and report the cookies they dropped', async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.cookie ?? '');
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>Session fixture</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-scope-'));
  const session = join(directory, 'session.json');
  await writeFile(
    session,
    JSON.stringify({
      cookies: [cookie('kept', '127.0.0.1'), cookie('foreign', '.idp.test')],
      origins: [],
    }),
  );
  const models: Models = {
    async plan() {
      return { objective: 'Wait', concerns: [] };
    },
    async choose(_j, _o, _p, actions) {
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
  try {
    await runSuite(
      suiteSchema.parse({
        name: 'Scoped session',
        baseURL: `http://127.0.0.1:${address.port}`,
        requiresAuth: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        journeys: [
          {
            id: 'scoped',
            goal: 'g',
            persona: 'p',
            startPath: '/',
            allowedPaths: ['/'],
            ready: {
              kind: 'visible',
              target: { by: 'role', role: 'heading', name: 'Session fixture' },
            },
            success: [{ kind: 'path', pattern: '^/never$' }],
            maxSteps: 1,
          },
        ],
      }),
      models,
      { directory: join(directory, 'run'), storageState: session },
    );
    assert.ok(seen.length > 0);
    assert.ok(seen.every((header) => header === 'kept=v'));
    const scoped = (
      await readFile(join(directory, 'run', 'events.jsonl'), 'utf8')
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'storage_state_scoped');
    assert.deepEqual(scoped.data.droppedCookies, { 'idp.test': 1 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('blocked requests to the suite origins are reported as harness findings, foreign ones are not', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<h1>Policy fixture</h1><script>
        fetch('/api/search', { method: 'POST', body: '{}' }).catch(() => {});
        fetch('https://foreign.example/collect', { method: 'POST' }).catch(() => {});
      </script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-policy-'));
  const models: Models = {
    async plan() {
      return { objective: 'Wait', concerns: [] };
    },
    async choose(_j, _o, _p, actions) {
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
  const suite = (readOnlyPosts: { origin: string; path: string }[]) =>
    suiteSchema.parse({
      name: 'Policy',
      baseURL,
      readOnlyPosts,
      viewports: [{ name: 'desktop', width: 800, height: 600 }],
      journeys: [
        {
          id: 'policy',
          goal: 'g',
          persona: 'p',
          startPath: '/',
          allowedPaths: ['/'],
          ready: {
            kind: 'visible',
            target: { by: 'role', role: 'heading', name: 'Policy fixture' },
          },
          success: [{ kind: 'path', pattern: '^/never$' }],
          maxSteps: 1,
        },
      ],
    });
  try {
    const [blocked] = await runSuite(suite([]), models, {
      directory: join(directory, 'blocked'),
    });
    assert.deepEqual(
      blocked!.findings
        .filter((finding) => finding.category === 'policy-block')
        .map((finding) => finding.description.split('. The page')[0]),
      [`Test request policy blocked POST ${baseURL}/api/search`],
    );
    const [allowed] = await runSuite(
      suite([{ origin: baseURL, path: '/api/search' }]),
      models,
      { directory: join(directory, 'allowed') },
    );
    assert.ok(
      !allowed!.findings.some((finding) => finding.category === 'policy-block'),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a persistent profile carries a one-time sign-in into every run', async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/sign-in')
      response.setHeader('Set-Cookie', 'signed=1; Max-Age=3600; Path=/');
    else seen.push(request.headers.cookie ?? '');
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>Profile fixture</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-profile-'));
  const profile = await dedicatedProfile(join(directory, 'profile'));
  const baseURL = `http://127.0.0.1:${address.port}`;
  // The one-time sign-in, as --sign-in does it.
  const { chromium } = await import('playwright');
  const signIn = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  await (signIn.pages()[0] ?? (await signIn.newPage())).goto(
    `${baseURL}/sign-in`,
  );
  await signIn.close();
  const models: Models = {
    async plan() {
      return { objective: 'Wait', concerns: [] };
    },
    async choose(_j, _o, _p, actions) {
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
  try {
    await runSuite(
      suiteSchema.parse({
        name: 'Profile session',
        baseURL,
        requiresAuth: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        journeys: [
          {
            id: 'profile',
            goal: 'g',
            persona: 'p',
            startPath: '/',
            allowedPaths: ['/'],
            ready: {
              kind: 'visible',
              target: { by: 'role', role: 'heading', name: 'Profile fixture' },
            },
            success: [{ kind: 'path', pattern: '^/never$' }],
            maxSteps: 1,
          },
        ],
      }),
      models,
      { directory: join(directory, 'run'), profile, repeat: 2 },
    );
    // Both runs, each opening the profile afresh, arrive signed in.
    const visits = (
      await readFile(join(directory, 'run', 'events.jsonl'), 'utf8')
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'journey_start');
    assert.equal(visits.length, 2);
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((header) => header.includes('signed=1')));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a persistent profile is a dedicated directory the runner created', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ui-ux-home-'));
  // A new directory is created owner-only and marked as a test profile.
  const fresh = await dedicatedProfile(join(home, 'profiles', 'app'), home);
  assert.ok(await isPrivate(fresh, 'directory'), `${fresh} is not private`);
  await stat(join(fresh, PROFILE_MARKER));
  // Reusing it is accepted once it holds browser data.
  await writeFile(join(fresh, 'Local State'), '{}');
  assert.equal(await dedicatedProfile(fresh, home), fresh);
  // Browser data locations under the home directory are refused outright,
  // even when the directory does not exist yet.
  for (const personal of [
    ['Library', 'Application Support', 'Google', 'Chrome', 'Default'],
    ['Library', 'Application Support', 'Dia', 'User Data'],
    ['.config', 'google-chrome'],
    ['.mozilla', 'firefox', 'abc.default'],
  ])
    await assert.rejects(
      dedicatedProfile(join(home, ...personal), home),
      /where browsers keep personal profiles/,
    );
  // So is an existing, non-empty directory the runner did not create, such
  // as a copied personal profile; nothing is written into it.
  const copied = join(home, 'copied-profile');
  await mkdir(copied);
  await writeFile(join(copied, 'Cookies'), '');
  await assert.rejects(
    dedicatedProfile(copied, home),
    /not created by this runner/,
  );
  await assert.rejects(stat(join(copied, PROFILE_MARKER)), {
    code: 'ENOENT',
  });
});

test('runs refuse a profile directory the runner did not create', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-ux-profile-'));
  const profile = join(directory, 'browser-profile');
  await mkdir(profile);
  await writeFile(join(profile, 'Cookies'), '');
  const models: Models = {
    async plan() {
      throw new Error('not reached');
    },
    async choose() {
      throw new Error('not reached');
    },
  };
  await assert.rejects(
    runSuite(
      suiteSchema.parse({
        name: 'Foreign profile',
        baseURL: 'http://127.0.0.1:9',
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        journeys: [
          {
            id: 'j',
            goal: 'g',
            persona: 'p',
            startPath: '/',
            allowedPaths: ['/'],
            ready: { kind: 'path', pattern: '.' },
            success: [{ kind: 'path', pattern: '^/never$' }],
          },
        ],
      }),
      models,
      { directory: join(directory, 'run'), profile },
    ),
    /not created by this runner/,
  );
});

test('the CLI has no option to read a session from an installed browser', async () => {
  for (const flag of ['--from-browser', '--browser-profile'])
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          '--suite',
          'examples/website.json',
          '--login',
          join(tmpdir(), 'never-written.json'),
          flag,
          'chrome',
        ],
        { env: { ...process.env } },
      ),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 2);
        assert.match(
          error.stderr ?? '',
          new RegExp(`Unknown option '${flag}'`),
        );
        assert.match(error.stderr ?? '', /--help for the supported options/);
        return true;
      },
    );
});
