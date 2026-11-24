// Playwright side of the accessibility scan: runs axe-core in the page through
// @axe-core/playwright and hands the raw output to the driver-independent
// parser. Playwright types stay in this file.
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import {
  parseAxeResults,
  scanError,
  type AccessibilityScan,
  type AccessibilityScope,
} from '../audits/accessibility.js';

export type AxeScanOptions = {
  // CSS selectors from explicit suite configuration; empty scans the page.
  include?: string[];
  exclude?: string[];
  // axe rule tags to limit the scan to (e.g. "wcag2a", "best-practice");
  // empty runs axe's default rule set.
  tags?: string[];
  disableRules?: string[];
  timeoutMs?: number;
};

export const DEFAULT_AXE_TIMEOUT_MS = 30_000;

class ScanTimeout extends Error {}

export async function scanAccessibility(
  page: Page,
  options: AxeScanOptions = {},
): Promise<AccessibilityScan> {
  const scope: AccessibilityScope = {
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  };
  const tags = options.tags ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_AXE_TIMEOUT_MS;
  const started = performance.now();
  const context = () => ({
    scope,
    tags,
    durationMs: Math.round(performance.now() - started),
  });
  let url = '';
  let timer: NodeJS.Timeout | undefined;
  try {
    url = page.url();
    const scan = async () => {
      // A scope region that is not on the page is reported, not scanned as
      // an empty (and therefore clean) region.
      for (const selector of scope.include)
        if ((await page.locator(`css=${selector}`).count()) === 0)
          return { missing: selector } as const;
      const builder = new AxeBuilder({ page })
        // Legacy mode runs axe.run in the page itself. The default mode
        // finishes the run in a new blank page of the same browser context,
        // which a session closes as a popup and records as a second page;
        // the cost is that cross-origin frames are not analyzed.
        .setLegacyMode(true);
      for (const selector of scope.include) builder.include(selector);
      for (const selector of scope.exclude) builder.exclude(selector);
      if (tags.length) builder.withTags(tags);
      if (options.disableRules?.length)
        builder.disableRules(options.disableRules);
      return { raw: (await builder.analyze()) as unknown } as const;
    };
    const running = scan();
    // After a timeout the scan may still settle; its result is discarded.
    running.catch(() => {});
    const outcome = await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ScanTimeout()), timeoutMs);
      }),
    ]);
    if ('missing' in outcome)
      return scanError(url, context(), {
        kind: 'scope_not_found',
        message: `Scan scope selector matched no element: ${outcome.missing}`,
      });
    return parseAxeResults(outcome.raw, url, context());
  } catch (error) {
    if (error instanceof ScanTimeout)
      return scanError(url, context(), {
        kind: 'timeout',
        message: `Accessibility scan did not finish within ${timeoutMs} ms`,
      });
    return scanError(url, context(), {
      kind: 'analyzer_exception',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}
