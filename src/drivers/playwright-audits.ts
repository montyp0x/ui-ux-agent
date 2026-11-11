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
import type { DriverAuditRequest } from './types.js';

export type PlaywrightAudit = (
  page: Page,
  request: DriverAuditRequest,
) => Promise<AuditOutput>;

// Leaves the runner's own deadline the last word only when the scan hangs:
// a scan that times out itself reports the error kind.
const SCAN_DEADLINE_MARGIN_MS = 250;

export const PLAYWRIGHT_AUDITS: Partial<Record<AuditId, PlaywrightAudit>> = {
  async 'accessibility.axe'(page, { config, timeoutMs }) {
    if (config.id !== 'accessibility.axe')
      throw new Error(`Expected the accessibility.axe config, got ${config.id}`);
    return axeAuditOutput(
      await scanAccessibility(page, {
        include: config.include,
        exclude: config.exclude,
        tags: config.tags,
        timeoutMs: Math.max(1, timeoutMs - SCAN_DEADLINE_MARGIN_MS),
      }),
    );
  },
};

export async function runPlaywrightAudit(
  page: Page,
  request: DriverAuditRequest,
): Promise<AuditOutput> {
  const audit = PLAYWRIGHT_AUDITS[request.config.id];
  if (!audit)
    throw new Error(
      `The Playwright driver has no implementation for audit ${request.config.id}`,
    );
  return audit(page, request);
}
