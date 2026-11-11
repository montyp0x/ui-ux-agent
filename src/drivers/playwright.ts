import { mkdir, readFile } from 'node:fs/promises';
import {
  chromium,
  firefox,
  webkit,
  type BrowserContextOptions,
} from 'playwright';
import {
  scopeStorageState,
  storageStateSchema,
  suiteOrigins,
} from '../auth.js';
import {
  allowedRequest,
  allowedURL,
  candidates,
  check,
  execute,
  observe,
  offeredControls,
  repeatState,
} from '../browser.js';
import type { Suite } from '../contracts.js';
import type { UIDriver } from './types.js';

// Which build to launch: Playwright's bundled browser, an installed channel,
// or another Chromium-based browser by path (e.g. Dia). Used by runs and by
// --login, so a session is captured in the same browser the runs use.
export function browserLaunchOptions(
  suite: Pick<Suite, 'browserChannel' | 'browserExecutable'>,
): { channel?: string; executablePath?: string } {
  if (suite.browserChannel) return { channel: suite.browserChannel };
  if (suite.browserExecutable)
    return { executablePath: suite.browserExecutable };
  return {};
}

export async function playwrightDriver(
  browserName: Suite['browser'],
  headless: boolean,
  build: Pick<Suite, 'browserChannel' | 'browserExecutable'> = {},
  // A persistent profile directory: each session opens it, so a sign-in done
  // once with --sign-in carries over (cookies, storage, device identity).
  profile?: string,
): Promise<UIDriver> {
  const engine = { chromium, firefox, webkit }[browserName];
  const launchOptions = {
    headless,
    ...browserLaunchOptions(build),
    // On HiDPI displays a headed Chromium window renders at the display's
    // pixel ratio while the page is emulated at 1, so every screenshot briefly
    // re-renders the window at a different scale (a visible flicker per step).
    // Pin the window to the emulated ratio; pages and screenshots are unchanged.
    ...(browserName === 'chromium' && !headless
      ? { args: ['--force-device-scale-factor=1'] }
      : {}),
  };
  if (profile) await mkdir(profile, { recursive: true, mode: 0o700 });
  const browser = profile ? null : await engine.launch(launchOptions);
  return {
    async openSession({
      suite,
      journey,
      viewport,
      directory,
      storageState,
      video,
      log,
    }) {
      // Load only the session material for the suite's own origins.
      let scoped: BrowserContextOptions['storageState'];
      if (storageState && profile)
        throw new Error('Use a profile or a storage state, not both');
      if (storageState) {
        const { state, report } = scopeStorageState(
          typeof storageState === 'string'
            ? storageStateSchema.parse(
                JSON.parse(await readFile(storageState, 'utf8')),
              )
            : storageState,
          suiteOrigins(suite),
        );
        await log('storage_state_scoped', report);
        scoped = state as BrowserContextOptions['storageState'];
      }
      const contextOptions = {
        viewport,
        serviceWorkers: 'block' as const,
        acceptDownloads: false,
        ...(video ? { recordVideo: { dir: directory } } : {}),
      };
      // Sessions run one at a time, so each can open the profile in turn.
      const context = browser
        ? await browser.newContext({ ...contextOptions, storageState: scoped })
        : await engine.launchPersistentContext(profile!, {
            ...launchOptions,
            ...contextOptions,
          });
      const page = browser
        ? await context.newPage()
        : (context.pages()[0] ?? (await context.newPage()));
      const browserErrors: string[] = [];
      const policyBlocks: string[] = [];
      const suiteHosts = new Set(suiteOrigins(suite));
      let unauthorized = false;
      await context.route('**/*', async (route) => {
        const request = route.request();
        // Journey scope governs where the page goes; iframes (consent,
        // anti-bot, embeds) load like other resources and only face the
        // write policy.
        const topLevel =
          request.isNavigationRequest() &&
          request.frame().parentFrame() === null;
        const blocked =
          !allowedRequest(request, suite) ||
          (topLevel &&
            !allowedURL(
              request.url(),
              suite.baseURL,
              journey.allowedPaths,
              suite.allowedOrigins,
            ));
        if (blocked) {
          const url = new URL(request.url());
          await log('policy_block', {
            method: request.method(),
            origin: url.origin,
            path: url.pathname,
          });
          // Blocked requests to the suite's own origins can degrade the page
          // under test; surface them so failures are not blamed on the app.
          if (!topLevel && suiteHosts.has(url.origin))
            policyBlocks.push(
              `${request.method()} ${url.origin}${url.pathname}`,
            );
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      context.on('page', (popup) => {
        if (popup !== page) void popup.close();
      });
      page.on('dialog', (dialog) => {
        void dialog.dismiss();
      });
      page.on('pageerror', (error) => {
        browserErrors.push(error.message);
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        const trusted = [
          suite.baseURL,
          ...suite.applicationOrigins,
          ...suite.readOnlyPosts.map((rule) => rule.origin),
        ].some((origin) => new URL(origin).origin === url.origin);
        if (trusted && response.status() === 401) unauthorized = true;
        if (response.status() >= 500)
          browserErrors.push(
            `HTTP ${response.status()}: ${url.origin}${url.pathname}`,
          );
      });
      page.on('console', (message) => {
        if (message.type() === 'error')
          void log('console_error', { message: message.text() });
      });
      page.on('requestfailed', (request) => {
        void log('request_failed', {
          method: request.method(),
          origin: new URL(request.url()).origin,
          path: new URL(request.url()).pathname,
          reason: request.failure()?.errorText,
        });
      });
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
      return {
        browserErrors,
        policyBlocks,
        get unauthorized() {
          return unauthorized;
        },
        async start(timeoutMs) {
          if (
            !allowedURL(
              journey.startPath,
              suite.baseURL,
              journey.allowedPaths,
              suite.allowedOrigins,
            )
          )
            throw new Error('Start path is outside the journey scope');
          await page.goto(new URL(journey.startPath, suite.baseURL).href, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          });
        },
        setTimeout(timeoutMs) {
          page.setDefaultTimeout(timeoutMs);
        },
        location() {
          return page.url();
        },
        check(condition) {
          return check(page, condition);
        },
        observe(step, screenshot) {
          return observe(page, step, screenshot);
        },
        candidates() {
          return candidates(
            page,
            journey,
            suite.baseURL,
            suite.allowedOrigins,
            log,
          );
        },
        repeatState(action) {
          return repeatState(page, action, journey);
        },
        offeredControls() {
          return offeredControls(page);
        },
        execute(action, before) {
          return execute(
            page,
            action,
            before,
            journey,
            suite.baseURL,
            suite.allowedOrigins,
          );
        },
        async screenshot(path) {
          await page.screenshot({ path });
        },
        async finish(trace) {
          const recording = page.video();
          try {
            await context.tracing.stop({ path: trace });
          } finally {
            await context.close();
          }
          return { video: recording ? await recording.path() : null };
        },
      };
    },
    async close() {
      await browser?.close();
    },
  };
}
