// Runs the responsive layout detectors through Playwright: one audit on the
// current page, a breakpoint sweep on a live page (restoring its viewport), or
// a matrix of fresh contexts (which also covers device pixel ratios).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Browser,
  BrowserContextOptions,
  ElementHandle,
  Page,
} from 'playwright';
import type { AuditOutput } from '../audits/contract.js';
import { layoutAuditOutput } from '../audits/layout-output.js';
import {
  activeExceptions,
  combineStatus,
  expandBreakpoints,
  layoutAuditConfigSchema,
  layoutAuditResultSchema,
  unmeasuredResult,
  type LayoutAuditConfig,
  type LayoutAuditConfigInput,
  type LayoutAuditResult,
  type LayoutBreakpoint,
} from '../audits/layout.js';
import {
  detectLayout,
  type DetectInput,
  type DetectOutput,
} from '../audits/layout-detect.js';
import { locate } from '../browser.js';
import type { Target } from '../contracts.js';
import type { DriverAuditRequest } from './types.js';

const LIMITS: DetectInput['limits'] = {
  findings: 50,
  items: 5,
  controls: 500,
  text: 20000,
};

function describeTarget(target: Target): string {
  return target.by === 'role'
    ? `${target.role} "${target.name}"`
    : `${target.by} "${target.value}"`;
}

function message(caught: unknown): string {
  return (caught instanceof Error ? caught.message : String(caught))
    .split('\n')[0]!
    .slice(0, 500);
}

// Fonts loaded and two frames rendered, so measurements see settled layout.
export async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

export async function auditLayout(
  page: Page,
  rawConfig: LayoutAuditConfigInput | LayoutAuditConfig,
  breakpoint: LayoutBreakpoint | null = null,
): Promise<LayoutAuditResult> {
  const config = layoutAuditConfigSchema.parse(rawConfig);
  const exceptions = activeExceptions(config.exceptions, breakpoint);
  const handles: ElementHandle[] = [];
  try {
    let required: DetectInput['required'] = null;
    let requiredError: string | null = null;
    if (config.rules.includes('occlusion') && config.requiredControls.length) {
      required = [];
      for (const [index, target] of config.requiredControls.entries())
        try {
          const elements = (await locate(
            page,
            target,
          ).elementHandles()) as ElementHandle<Element>[];
          handles.push(...elements);
          required.push({
            index,
            label: describeTarget(target),
            elements: elements as unknown as Element[],
          });
        } catch (caught) {
          requiredError = `Required control #${index} (${describeTarget(target)}) could not be resolved: ${message(caught)}`;
          break;
        }
    }
    // Handles in the argument arrive in the page as their elements.
    const input: DetectInput = {
      rules: config.rules,
      tolerancePx: config.clipping.tolerancePx,
      minCoveredFraction: config.occlusion.minCoveredFraction,
      minimum: config.targetSize.minimum,
      spacingExemption:
        config.targetSize.spacingExemption ?? config.targetSize.minimum <= 24,
      exceptions: exceptions.map(({ index, rule, selector, reason }) => ({
        index,
        rule,
        selector,
        reason,
      })),
      required,
      limits: LIMITS,
    };
    const raw = await page.evaluate(
      detectLayout as unknown as (arg: unknown) => DetectOutput,
      input as unknown,
    );
    const horizontalOverflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    );
    const detectors = raw.detectors.map((detector) =>
      detector.rule === 'occlusion' && requiredError
        ? {
            ...detector,
            status: 'error' as const,
            error: requiredError,
          }
        : detector,
    );
    // The page's output is untrusted until it parses against the contract.
    return layoutAuditResultSchema.parse({
      version: 1,
      status: combineStatus(detectors.map((detector) => detector.status)),
      url: raw.url,
      breakpoint,
      viewport: raw.viewport,
      horizontalOverflow,
      detectors,
      exceptions: config.exceptions.map((exception, index) => ({
        index,
        rule: exception.rule,
        selector: exception.selector,
        reason: exception.reason,
        active: exceptions.some((active) => active.index === index),
        uses: raw.uses[index] ?? 0,
      })),
      detail: null,
    });
  } catch (caught) {
    return unmeasuredResult(
      'error',
      `Layout audit failed: ${message(caught)}`,
      config,
      breakpoint,
      page.isClosed() ? '' : page.url(),
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
}

// Resizes the live page through each breakpoint and restores its viewport, so
// a journey continues unchanged. A page cannot change its device pixel ratio,
// so breakpoints asking for another one are reported unsupported.
export async function auditAtBreakpoints(
  page: Page,
  breakpoints: LayoutBreakpoint[],
  rawConfig: LayoutAuditConfigInput | LayoutAuditConfig,
  // Epoch ms after which remaining breakpoints are skipped as incomplete.
  deadline?: number,
): Promise<LayoutAuditResult[]> {
  const config = layoutAuditConfigSchema.parse(rawConfig);
  const original = page.viewportSize();
  if (!original)
    return breakpoints.map((breakpoint) =>
      unmeasuredResult(
        'unsupported',
        'The page has no fixed viewport to resize',
        config,
        breakpoint,
        page.url(),
      ),
    );
  const { ratio, scrollX, scrollY } = await page.evaluate(() => ({
    ratio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }));
  const results: LayoutAuditResult[] = [];
  try {
    for (const breakpoint of breakpoints) {
      if (deadline !== undefined && Date.now() > deadline) {
        results.push(
          unmeasuredResult(
            'incomplete',
            `Not measured at ${breakpoint.name}: the audit time budget ran out`,
            config,
            breakpoint,
            page.url(),
          ),
        );
        continue;
      }
      if (
        breakpoint.deviceScaleFactor !== null &&
        breakpoint.deviceScaleFactor !== ratio
      ) {
        results.push(
          unmeasuredResult(
            'unsupported',
            `Device pixel ratio ${breakpoint.deviceScaleFactor} needs a new browser context; this page renders at ${ratio}`,
            config,
            breakpoint,
            page.url(),
          ),
        );
        continue;
      }
      try {
        await page.setViewportSize({
          width: breakpoint.width,
          height: breakpoint.height,
        });
        await settleLayout(page);
      } catch (caught) {
        results.push(
          unmeasuredResult(
            'error',
            `Could not resize to ${breakpoint.name}: ${message(caught)}`,
            config,
            breakpoint,
            page.isClosed() ? '' : page.url(),
          ),
        );
        continue;
      }
      results.push(await auditLayout(page, config, breakpoint));
    }
  } finally {
    if (!page.isClosed()) {
      await page.setViewportSize(original);
      await settleLayout(page);
      await page.evaluate(
        ([x, y]) => window.scrollTo(x!, y!),
        [scrollX, scrollY],
      );
    }
  }
  return results;
}

// One fresh context per breakpoint: isolated state and real device pixel
// ratios. `open` brings the page to the state under test.
export async function auditLayoutMatrix(options: {
  browser: Browser;
  breakpoints: LayoutBreakpoint[];
  config: LayoutAuditConfigInput | LayoutAuditConfig;
  open(page: Page, breakpoint: LayoutBreakpoint): Promise<void>;
  contextOptions?: Omit<
    BrowserContextOptions,
    'viewport' | 'deviceScaleFactor'
  >;
}): Promise<LayoutAuditResult[]> {
  const config = layoutAuditConfigSchema.parse(options.config);
  const results: LayoutAuditResult[] = [];
  for (const breakpoint of options.breakpoints) {
    const context = await options.browser.newContext({
      ...options.contextOptions,
      viewport: { width: breakpoint.width, height: breakpoint.height },
      ...(breakpoint.deviceScaleFactor !== null
        ? { deviceScaleFactor: breakpoint.deviceScaleFactor }
        : {}),
    });
    try {
      const page = await context.newPage();
      try {
        await options.open(page, breakpoint);
        await settleLayout(page);
      } catch (caught) {
        results.push(
          unmeasuredResult(
            'error',
            `Could not open the page at ${breakpoint.name}: ${message(caught)}`,
            config,
            breakpoint,
            page.isClosed() ? '' : page.url(),
          ),
        );
        continue;
      }
      results.push(await auditLayout(page, config, breakpoint));
    } finally {
      await context.close();
    }
  }
  return results;
}

// The `layout.responsive` driver audit: the session's viewport as it is, then
// each extra breakpoint and the reflow case in place. The viewport and scroll
// position are restored before returning so the journey continues unchanged,
// and breakpoints are skipped (incomplete) once 60% of the time budget is
// spent, leaving room to restore before the runner's timeout.
export async function layoutResponsivePlaywrightAudit(
  page: Page,
  request: DriverAuditRequest,
): Promise<AuditOutput> {
  const { config, checkpoint, directory, timeoutMs, viewport } = request;
  if (config.id !== 'layout.responsive')
    throw new Error(`Not a layout audit: ${config.id}`);
  const deadline = Date.now() + timeoutMs * 0.6;
  const size = page.viewportSize();
  if (!size) throw new Error('The page has no fixed viewport to measure');
  const layout = layoutAuditConfigSchema.parse({
    rules: config.rules,
    requiredControls: config.requiredControls,
    clipping: config.clipping,
    occlusion: config.occlusion,
    targetSize: config.targetSize,
    exceptions: config.exceptions,
  });
  // The session's viewport carries its suite name, so exceptions scoped to
  // that name apply here.
  const session: LayoutBreakpoint = {
    name: viewport.name,
    width: size.width,
    height: size.height,
    deviceScaleFactor: null,
    kind: 'viewport',
    zoom: null,
  };
  // A matrix entry naming the session's viewport is that viewport, measured
  // once; under the same name with another size it is a configuration error.
  const extras = expandBreakpoints(config.matrix, [], true).filter((entry) => {
    if (entry.name !== session.name) return true;
    if (entry.width !== session.width || entry.height !== session.height)
      throw new Error(
        `Breakpoint ${entry.name} is ${entry.width}x${entry.height} but the session's ${session.name} viewport is ${session.width}x${session.height}`,
      );
    return false;
  });
  const results = [
    await auditLayout(page, layout, session),
    ...(await auditAtBreakpoints(page, extras, layout, deadline)),
  ];
  // Boxes, measurements, exemptions and the exception ledger, for
  // reproduction. Page text is limited to the short excerpts findings carry.
  const file = join(
    directory,
    `layout-${checkpoint.id.replace(/[^a-z0-9-]+/gi, '-')}-step${checkpoint.step}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({ checkpoint: checkpoint.id, results }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return layoutAuditOutput(results, { session: session.name, files: [file] });
}
