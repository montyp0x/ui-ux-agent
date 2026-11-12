// Playwright implementations of driver audits (audits without a core
// `evaluate` in src/audits/registry.ts). Each receives the session's page and
// the request, and returns output that the runner parses with
// auditOutputSchema. Throw for an analyzer failure or a configured scope that
// matches nothing: the runner records that as an `error` run, never clean.
// Only fixed engine code runs in the page; never model-generated scripts.
import type { Page } from 'playwright';
import type { AuditOutput } from '../audits/contract.js';
import type { AuditId } from '../audits/config.js';
import { axeAuditOutput } from '../audits/accessibility.js';
import { scanAccessibility } from './playwright-axe.js';
import { layoutResponsivePlaywrightAudit } from './playwright-layout.js';
import type { ScreenshotProtection } from '../evidence/protection.js';
import {
  visualBaselinePlaywrightAudit,
  type PlaywrightBuild,
} from './playwright-visual.js';
import type { DriverAuditRequest } from './types.js';
import type { Journey } from '../contracts.js';
import { keyboardFocusPlaywrightAudit } from './playwright-keyboard.js';

// What the session knows beyond the page, for audits that read it.
export type PlaywrightAuditContext = {
  journey: Journey;
  // The screenshot the session took for an observation step, if any.
  screenshotAt(step: number): string | null;
  // How the session's browser was launched (audits that key by it).
  build: PlaywrightBuild;
  // The run's screenshot protection, for audits that capture images;
  // undefined only for sessions opened without an evidence policy.
  protection: ScreenshotProtection | undefined;
};

export type PlaywrightAudit = (
  page: Page,
  request: DriverAuditRequest,
  // Given by the session; audits that only read the page ignore it.
  context?: PlaywrightAuditContext,
) => Promise<AuditOutput>;

// Leaves the runner's own deadline the last word only when the scan hangs:
// a scan that times out itself reports the error kind.
const SCAN_DEADLINE_MARGIN_MS = 250;

export const PLAYWRIGHT_AUDITS: Partial<Record<AuditId, PlaywrightAudit>> = {
  async 'accessibility.axe'(page, { config, timeoutMs }) {
    if (config.id !== 'accessibility.axe')
      throw new Error(
        `Expected the accessibility.axe config, got ${config.id}`,
      );
    return axeAuditOutput(
      await scanAccessibility(page, {
        include: config.include,
        exclude: config.exclude,
        tags: config.tags,
        timeoutMs: Math.max(1, timeoutMs - SCAN_DEADLINE_MARGIN_MS),
      }),
    );
  },
  'layout.responsive': layoutResponsivePlaywrightAudit,
  async 'visual.baseline'(page, request, context) {
    if (!context) throw new Error('visual.baseline needs the session context');
    return visualBaselinePlaywrightAudit(
      page,
      request,
      context.build,
      context.protection,
    );
  },
  // Reads the focus transitions the journey's own key presses recorded; it
  // presses no key itself.
  async 'keyboard.focus'(page, _request, context) {
    if (!context) throw new Error('keyboard.focus needs the session context');
    return keyboardFocusPlaywrightAudit(
      page,
      context.journey,
      context.screenshotAt,
    );
  },
};

export async function runPlaywrightAudit(
  page: Page,
  request: DriverAuditRequest,
  context: PlaywrightAuditContext,
): Promise<AuditOutput> {
  const audit = PLAYWRIGHT_AUDITS[request.config.id];
  if (!audit)
    throw new Error(
      `The Playwright driver has no implementation for audit ${request.config.id}`,
    );
  return audit(page, request, context);
}
