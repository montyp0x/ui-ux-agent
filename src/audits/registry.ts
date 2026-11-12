// The audit registry. An audit declares the drivers that support it; on any
// other driver it is reported as unsupported at each checkpoint, never run
// and never counted as clean.
//
// Three kinds of audit:
// - core audits (`evaluate`) read the observations the runner already
//   recorded, so they need no driver call;
// - session audits (`inspect`) use only the driver-neutral UISession
//   interface (check), so any driver that evaluates checks can run them;
// - driver audits (neither) run inside the driver via
//   UISession.runAudit, which dispatches to the driver's own implementation
//   (for Playwright, src/drivers/playwright-audits.ts). Their output is
//   parsed with auditOutputSchema at that boundary.
import type { Check, Journey, Observation } from '../contracts.js';
import type { AuditConfig, AuditId } from './config.js';
import type { AuditCheckpoint, AuditOutput, DriverKind } from './contract.js';
import { axeAudit } from './accessibility.js';
import { horizontalOverflowAudit } from './horizontal-overflow.js';
import { layoutResponsiveAudit } from './layout-output.js';
import { visualBaselineAudit } from './visual.js';
import { keyboardFocusAudit } from './keyboard.js';
import { stateChecksAudit } from './state-checks.js';
import { designTokensAudit } from './design-tokens.js';

export type AuditContext<C extends AuditConfig = AuditConfig> = {
  checkpoint: AuditCheckpoint;
  config: C;
  // States observed since this audit's previous run (the checkpoint's own
  // state included), or the checkpoint's state alone when none are new.
  observations: Observation[];
};

export type SessionAuditContext<C extends AuditConfig = AuditConfig> =
  AuditContext<C> & {
    journey: Journey;
    // The session's check, against its current state.
    check: (condition: Check) => Promise<boolean>;
  };

export type AuditDefinition<C extends AuditConfig = AuditConfig> = {
  id: C['id'];
  // The analyzer behind it: builtin, axe-core ...
  source: string;
  title: string;
  drivers: readonly DriverKind[];
  // Reason reported where the driver is not in `drivers`.
  unsupported: string;
  evaluate?: (context: AuditContext<C>) => AuditOutput;
  inspect?: (context: SessionAuditContext<C>) => Promise<AuditOutput>;
};

type Registry = {
  [K in AuditId]: AuditDefinition<Extract<AuditConfig, { id: K }>>;
};

export const AUDITS: Registry = {
  'layout.horizontal-overflow': horizontalOverflowAudit,
  'accessibility.axe': axeAudit,
  'layout.responsive': layoutResponsiveAudit,
  'visual.baseline': visualBaselineAudit,
  'journey.state-checks': stateChecksAudit,
  'keyboard.focus': keyboardFocusAudit,
  'design.tokens': designTokensAudit,
};

export const auditDefinition = (id: AuditId): AuditDefinition =>
  AUDITS[id] as AuditDefinition;
