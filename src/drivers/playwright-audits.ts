// Playwright implementations of driver audits (audits without a core
// `evaluate` in src/audits/registry.ts). Each receives the session's page and
// the request, and returns output that the runner parses with
// auditOutputSchema. Throw for an analyzer failure or a configured scope that
// matches nothing: the runner records that as an `error` run, never clean.
// Only fixed engine code runs in the page; never model-generated scripts.
import type { Page } from 'playwright';
import type { AuditOutput } from '../audits/contract.js';
import type { AuditId } from '../audits/config.js';
import type { DriverAuditRequest } from './types.js';

export type PlaywrightAudit = (
  page: Page,
  request: DriverAuditRequest,
) => Promise<AuditOutput>;

export const PLAYWRIGHT_AUDITS: Partial<Record<AuditId, PlaywrightAudit>> = {};

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
