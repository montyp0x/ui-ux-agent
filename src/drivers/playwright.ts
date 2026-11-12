import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  chromium,
  firefox,
  webkit,
  type BrowserContextOptions,
} from 'playwright';
import {
  dedicatedProfile,
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
import { runPlaywrightAudit } from './playwright-audits.js';
import {
  learnSecretOptions,
  protectedScreenshot,
} from './playwright-evidence.js';
import { formatEnabled } from '../evidence/policy.js';
import { focusKey } from './playwright-keyboard.js';
import {
  ENVIRONMENT_PROBE,
  environmentContextOptions,
  environmentProbeSchema,
  markPseudoLocalized,
  pseudoLocalizationScript,
  unappliedSettings,
} from '../environments.js';
import {
  ENGINE_GAPS,
  engineAuditGap,
  environmentEmulation,
} from '../browser-support.js';
import {
  preparePerformance,
  type PerformanceRecorder,
} from './playwright-performance.js';

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
  // Only a dedicated test profile; a personal browser profile is refused.
  if (profile) profile = await dedicatedProfile(profile);
  const browser = profile ? null : await engine.launch(launchOptions);
  const buildName = build.browserChannel
    ? `channel:${build.browserChannel}`
    : build.browserExecutable
      ? 'executable'
      : 'bundled';
  // A persistent-profile context has no Browser object: its version is read
  // from the first session's user agent.
  let profileVersion: string | null = null;
  return {
    environment() {
      return {
        driver: 'playwright',
        browser: {
          name: browserName,
          version: browser?.version() ?? profileVersion,
          build: buildName,
          headless,
        },
      };
    },
    async openSession({
      suite,
      journey,
      viewport,
      environment,
      directory,
      storageState,
      video,
      log,
      evidence,
    }) {
      const traced = evidence ? formatEnabled(evidence.formats, 'trace') : true;
      const recorded =
        !!video && (evidence ? formatEnabled(evidence.formats, 'video') : true);
      // Written by the runner, not by Playwright, so the file is private
      // (0600) from the moment it exists.
      const capture = async (path: string) => {
        const started = Date.now();
        const image = await protectedScreenshot(page, evidence?.screenshots, {
          fullPage: false,
        });
        timing?.screenshot(Date.now() - started);
        await writeFile(path, image, { mode: 0o600 });
        return image;
      };
      // Set once the page exists (performance.web suites only).
      let timing: PerformanceRecorder | null = null;
      // Load only the session material for the suite's own origins.
      let scoped: BrowserContextOptions['storageState'];
      if (storageState && profile)
        throw new Error('Use a profile or a storage state, not both');
      if (storageState) {
        const { state, report } = scopeStorageState(
          storageStateSchema.parse(
            JSON.parse(await readFile(storageState, 'utf8')),
          ),
          suiteOrigins(suite),
        );
        await log('storage_state_scoped', report);
        scoped = state as BrowserContextOptions['storageState'];
      }
      // Only what this engine is verified to emulate is applied; the rest of
      // the environment is withheld and reported unsupported (never
      // half-applied, never assumed).
      const emulation = environment
        ? environmentEmulation(browserName, environment)
        : null;
      const emulated = emulation?.environment ?? null;
      const contextOptions = {
        viewport,
        // Locale, time zone and media emulation of the suite environment.
        ...environmentContextOptions(emulated),
        serviceWorkers: 'block' as const,
        acceptDownloads: false,
        ...(recorded ? { recordVideo: { dir: directory } } : {}),
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
      // Pseudo-localized long text: expand the application's text in every
      // page the session loads (src/environments.ts).
      if (emulated?.pseudoLocalization) {
        await context.addInitScript({
          content: pseudoLocalizationScript(emulated.pseudoLocalization),
        });
        markPseudoLocalized(page);
      }
      if (!browser && profileVersion === null)
        profileVersion =
          /(?:HeadlessChrome|Chrome|Chromium|Firefox|Version)\/(\d+(?:\.\d+)*)/.exec(
            await page.evaluate(() => navigator.userAgent),
          )?.[1] ?? null;
      // Option labels that name a secret choice become secrets before any
      // page text leaves the driver.
      const learn = () => learnSecretOptions(page, evidence);
      // Before the first navigation: collector script and conditions.
      timing = await preparePerformance(
        context,
        page,
        suite,
        browserName,
        log,
      );
      const browserErrors: string[] = [];
      // Screenshot path of each observation step, for audit evidence.
      const screenshots = new Map<number, string>();
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
      // Traces hold DOM snapshots, network traffic and unmasked screenshots;
      // the evidence policy decides whether one is captured at all.
      if (traced)
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false,
        });
      return {
        driver: 'playwright' as const,
        browserErrors,
        policyBlocks,
        get unauthorized() {
          return unauthorized;
        },
        engineGaps: ENGINE_GAPS[browserName],
        environmentGaps: emulation?.unsupported ?? [],
        auditUnsupported(id) {
          return engineAuditGap(browserName, id);
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
          if (environment && emulated) {
            // The page, not the configuration, says what was emulated: a
            // setting the browser did not apply fails the run instead of
            // measuring another environment. Settings the engine does not
            // emulate were withheld and are reported unsupported instead.
            const measured = environmentProbeSchema.parse(
              await page.evaluate(ENVIRONMENT_PROBE),
            );
            const missing = unappliedSettings(emulated, measured);
            await log('environment_applied', {
              environment: environment.name,
              measured,
              pseudoLocalization: !!emulated.pseudoLocalization,
              unapplied: missing,
              unsupported: emulation?.unsupported ?? [],
            });
            if (missing.length)
              throw new Error(
                `Environment ${environment.name}: ${suite.browser} did not apply ${missing.join(', ')}`,
              );
          }
        },
        setTimeout(timeoutMs) {
          page.setDefaultTimeout(timeoutMs);
        },
        location() {
          return page.url();
        },
        async check(condition) {
          await learn();
          return check(page, condition);
        },
        async observe(step, screenshot) {
          await learn();
          screenshots.set(step, screenshot);
          const observation = await observe(page, step, screenshot, capture);
          // Keyboard focus is part of a keyboard-only journey's state.
          if (journey.input === 'keyboard')
            observation.fingerprint = createHash('sha256')
              .update(observation.fingerprint + (await focusKey(page)))
              .digest('hex');
          return observation;
        },
        async candidates() {
          await learn();
          return candidates(
            page,
            journey,
            suite.baseURL,
            suite.allowedOrigins,
            log,
          );
        },
        async repeatState(action) {
          await learn();
          return repeatState(page, action, journey);
        },
        offeredControls() {
          return offeredControls(page);
        },
        async execute(action, before) {
          try {
            return await execute(
              page,
              action,
              before,
              journey,
              suite.baseURL,
              suite.allowedOrigins,
            );
          } finally {
            // An error message can quote the page.
            await learn();
          }
        },
        async screenshot(path) {
          await learn();
          await capture(path);
        },
        async runAudit(request) {
          await learn();
          const run = () => runPlaywrightAudit(page, request, {
            journey,
            screenshotAt: (step) => screenshots.get(step) ?? null,
            build: {
              browser: browserName,
              build: suite.browserChannel
                ? `channel:${suite.browserChannel}`
                : suite.browserExecutable
                  ? 'executable'
                  : 'bundled',
              headless,
            },
            // The run's screenshot protection: visual captures get the same
            // pre-capture masks as every other screenshot, on top of the
            // audit's own dynamic-region masks.
            protection: evidence?.screenshots,
            performance: timing,
          });
          // Another audit's page work is harness time for performance.web.
          return timing && request.config.id !== 'performance.web'
            ? timing.during(run)
            : run();
        },
        async finish(trace) {
          const recording = page.video();
          try {
            if (traced) await context.tracing.stop({ path: trace });
          } finally {
            await context.close();
          }
          return {
            video: recording ? await recording.path() : null,
            ...(traced ? {} : { trace: null }),
          };
        },
      };
    },
    async close() {
      await browser?.close();
    },
  };
}
