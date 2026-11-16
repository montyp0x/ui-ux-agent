// Playwright capture for the visual.baseline audit: settle the page, take
// screenshots under fixed settings until two consecutive ones are identical,
// describe the rendering environment, then compare (src/audits/visual.ts).
// Only fixed engine code runs in the page; mask selectors come from the
// suite configuration, never from model output.
import { arch, platform, release } from 'node:os';
import type { Locator, Page, PageScreenshotOptions } from 'playwright';
import { PNG } from 'pngjs';
import type { AuditOutput } from '../audits/contract.js';
import { compareCheckpoint } from '../audits/visual.js';
import {
  visualKeySchema,
  type VisualComparison,
  type VisualEnvironment,
  type VisualRect,
} from '../audits/visual-contract.js';
import {
  MASK_COLOR,
  type ScreenshotProtection,
} from '../evidence/protection.js';
import { protectedScreenshot, screenshotMasks } from './playwright-evidence.js';
import type { DriverAuditRequest } from './types.js';

// How the session's browser was launched; part of the compatibility key.
export type PlaywrightBuild = {
  browser: 'chromium' | 'firefox' | 'webkit';
  // bundled, channel:<name> or executable
  build: string;
  headless: boolean;
};

// Resolves the audit's own dynamic-region masks for one capture. The run's
// evidence protection (secrets, suite.evidence masks) is applied on top by
// protectedScreenshot, in the same colour, so both kinds of masked area are
// solid MASK_COLOR in the baseline and in every comparison image.
export async function visualMasks(
  page: Page,
  selectors: readonly string[],
): Promise<{
  options: Pick<PageScreenshotOptions, 'mask' | 'maskColor'>;
  report: VisualComparison['masks'];
}> {
  const mask: Locator[] = [];
  const report: VisualComparison['masks'] = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    // A selector that matches nothing hides nothing; reported as a
    // limitation, not an error.
    report.push({ selector, matched: await locator.count() });
    mask.push(locator);
  }
  return { options: { mask, maskColor: MASK_COLOR }, report };
}

// Boxes of every element the capture masks (the audit's own masks and the
// evidence protection's), in whole CSS pixels of the image, after the page
// settled. A full-page image is in document coordinates.
export async function maskedRegions(
  page: Page,
  masks: readonly Locator[],
  protection: ScreenshotProtection | undefined,
  fullPage: boolean,
): Promise<VisualRect[]> {
  const locators = [
    ...masks,
    ...(protection ? await screenshotMasks(page, protection) : []),
  ];
  const out: VisualRect[] = [];
  for (const locator of locators) {
    const rects = await locator
      .evaluateAll(
        (elements, full) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left + (full ? window.scrollX : 0),
              top: rect.top + (full ? window.scrollY : 0),
              right: rect.right + (full ? window.scrollX : 0),
              bottom: rect.bottom + (full ? window.scrollY : 0),
            };
          }),
        fullPage,
      )
      .catch(() => []);
    for (const rect of rects) {
      const x = Math.max(0, Math.floor(rect.left));
      const y = Math.max(0, Math.floor(rect.top));
      const width = Math.ceil(rect.right) - x;
      const height = Math.ceil(rect.bottom) - y;
      if (width > 0 && height > 0 && out.length < 500)
        out.push({ x, y, width, height });
    }
  }
  return out;
}

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

// Waits for fonts, images and (best effort) network idle. Each wait that does
// not finish in time becomes a limitation; the stability check still decides.
async function settle(
  page: Page,
  networkIdleMs: number,
  deadline: number,
): Promise<string[]> {
  const limitations: string[] = [];
  if (networkIdleMs > 0)
    try {
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(networkIdleMs, remaining(deadline)),
      });
    } catch {
      limitations.push(
        `The network did not go idle within ${networkIdleMs}ms before capture`,
      );
    }
  try {
    await page.waitForFunction(
      () =>
        document.fonts.status === 'loaded' &&
        Array.from(document.images).every((image) => image.complete),
      undefined,
      { timeout: Math.min(5000, remaining(deadline)) },
    );
  } catch {
    limitations.push('Web fonts or images were still loading at capture');
  }
  return limitations;
}

function samePixels(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  const first = PNG.sync.read(a);
  const second = PNG.sync.read(b);
  return (
    first.width === second.width &&
    first.height === second.height &&
    first.data.equals(second.data)
  );
}

// Screenshots until two consecutive ones are identical; null when the page
// never settled within maxCaptures. Every image goes through
// protectedScreenshot, so evidence protections are applied while the page
// renders and no secret reaches a capture, a baseline or a diff.
export async function stableCapture(
  page: Page,
  protection: ScreenshotProtection | undefined,
  options: PageScreenshotOptions,
  maxCaptures: number,
  deadline: number,
): Promise<{ png: Buffer | null; captures: number }> {
  const shot = () =>
    protectedScreenshot(page, protection, {
      ...options,
      // Fixed capture settings: finite CSS animations and transitions are
      // finished and infinite ones reset, the text caret is hidden, and the
      // image is in CSS pixels whatever the device scale factor.
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      timeout: remaining(deadline),
    });
  let previous = await shot();
  for (let captures = 2; captures <= maxCaptures; captures++) {
    const current = await shot();
    if (samePixels(previous, current)) return { png: current, captures };
    previous = current;
  }
  return { png: null, captures: maxCaptures };
}

const UA_VERSION =
  /(?:HeadlessChrome|Chrome|Chromium|Firefox|Version)\/(\d+(?:\.\d+)*)/;

export async function captureEnvironment(
  page: Page,
  build: PlaywrightBuild,
  capture: VisualEnvironment['capture'],
  viewport: { width: number; height: number },
): Promise<VisualEnvironment> {
  const probe = await page.evaluate(() => ({
    deviceScaleFactor: window.devicePixelRatio,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    light: matchMedia('(prefers-color-scheme: light)').matches,
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    userAgent: navigator.userAgent,
  }));
  // A persistent-profile context has no Browser object; read the user agent.
  const version =
    page.context().browser()?.version() ??
    UA_VERSION.exec(probe.userAgent)?.[1] ??
    'unknown';
  return {
    viewport: page.viewportSize() ?? viewport,
    browser: {
      name: build.browser,
      version,
      build: build.build,
      headless: build.headless,
    },
    os: {
      platform: platform(),
      arch: arch(),
      release: release().split('.')[0] ?? release(),
    },
    deviceScaleFactor: probe.deviceScaleFactor,
    locale: probe.locale || 'unknown',
    timezone: probe.timezone || 'unknown',
    colorScheme: probe.dark ? 'dark' : probe.light ? 'light' : 'no-preference',
    reducedMotion: probe.reduce ? 'reduce' : 'no-preference',
    capture,
  };
}

// Leaves the runner's own deadline the last word only when capture hangs.
const CAPTURE_DEADLINE_MARGIN_MS = 250;

// protection: the run's screenshot protection (EvidenceProtection.
// screenshots from src/evidence/protection.ts), undefined when the run has
// none.
export async function visualBaselinePlaywrightAudit(
  page: Page,
  request: DriverAuditRequest,
  build: PlaywrightBuild,
  protection: ScreenshotProtection | undefined,
): Promise<AuditOutput> {
  const { config } = request;
  if (config.id !== 'visual.baseline')
    throw new Error(`Expected the visual.baseline config, got ${config.id}`);
  const deadline =
    Date.now() + Math.max(1, request.timeoutMs - CAPTURE_DEADLINE_MARGIN_MS);
  const key = visualKeySchema.parse({
    suite: request.scope.suite,
    journey: request.scope.journey,
    checkpoint: request.checkpoint.id,
    viewport: request.viewport.name,
    ...(request.environment ? { environment: request.environment } : {}),
  });
  const limitations = await settle(page, config.networkIdleMs, deadline);
  const masks = await visualMasks(page, config.mask);
  const environment = await captureEnvironment(
    page,
    build,
    {
      fullPage: config.fullPage,
      masks: [...config.mask],
      protected: protection !== undefined,
    },
    request.viewport,
  );
  const { png, captures } = await stableCapture(
    page,
    protection,
    { fullPage: config.fullPage, ...masks.options },
    config.maxCaptures,
    deadline,
  );
  return compareCheckpoint({
    key,
    maskedRegions: png
      ? await maskedRegions(
          page,
          masks.options.mask ?? [],
          protection,
          config.fullPage,
        )
      : [],
    environment,
    settings: config,
    current: png,
    captures,
    masks: masks.report,
    baselines: request.baselines,
    directory: request.directory,
    limitations,
  });
}
