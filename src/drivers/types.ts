import type {
  Action,
  Check,
  Journey,
  Observation,
  Suite,
} from '../contracts.js';
import type { AuditConfig, AuditId } from '../audits/config.js';
import type { EngineGap } from '../browser-support.js';
import type { AuditCheckpoint, DriverKind } from '../audits/contract.js';
import type { EvidenceProtection } from '../evidence/protection.js';
import type { DriverEnvironment } from '../identity.js';
import type { Environment } from '../environments.js';

export type EventLogger = (event: string, data: unknown) => Promise<void>;
export type SessionOptions = {
  suite: Suite;
  journey: Journey;
  viewport: { width: number; height: number };
  // The suite environment to emulate (src/environments.ts); null or omitted
  // keeps the browser's defaults. A setting the driver applies but the page
  // does not show fails the run; a setting the driver's engine does not
  // emulate is withheld and reported in UISession.environmentGaps.
  environment?: Environment | null;
  directory: string;
  storageState?: string;
  video?: boolean;
  log: EventLogger;
  // The run's evidence protection: screenshot masks applied before capture
  // and which formats (trace, video) may be captured. When omitted, drivers
  // capture unprotected screenshots and a trace, as before.
  evidence?: EvidenceProtection;
};

// A driver audit to run against the session's current state.
export type DriverAuditRequest = {
  config: AuditConfig;
  checkpoint: AuditCheckpoint;
  // The session's configured viewport (suite viewport name and size).
  viewport: { name: string; width: number; height: number };
  // The suite environment's name, or null/omitted without environments.
  // Audits that store state per configuration (visual baselines) key it by
  // the environment too.
  environment?: string | null;
  // The run directory: evidence files the audit writes go here.
  directory: string;
  // The suite and journey being run, for audits that key stored state
  // (visual baselines) by them.
  scope: { suite: string; journey: string };
  // The user-supplied baseline directory (--baselines), or null. Read-only
  // for audits: only an explicit approval writes into it.
  baselines: string | null;
  // The audit must finish within this; the runner also enforces it.
  timeoutMs: number;
  // Harness time spent so far in the journey: wall clock since it started,
  // model calls and earlier audit runs. Null or omitted when the runner does
  // not track it.
  harness?: {
    elapsedMs: number;
    modelCalls: number;
    modelMs: number;
    auditMs: number;
  } | null;
};

export interface UISession {
  // Which driver implements the session, for audit support. When omitted the
  // runner assumes the suite platform's driver (web: playwright).
  readonly driver?: DriverKind;
  readonly browserErrors: string[];
  // Non-navigation requests to the suite's own origins that the request policy
  // blocked, as "METHOD origin/path".
  readonly policyBlocks?: string[];
  readonly unauthorized: boolean;
  // What the session's browser engine is not verified to do
  // (src/browser-support.ts): run-wide gaps listed in quality.unsupported,
  // and the reason an audit is reported unsupported instead of run (null when
  // the engine runs it). Omitted: no engine-specific gaps.
  readonly engineGaps?: EngineGap[];
  // Settings of the suite environment the engine does not emulate, withheld
  // from the session (src/browser-support.ts environmentEmulation): listed
  // on the result's environment and in quality.unsupported, and the quality
  // verdict cannot pass. Omitted or empty: the whole environment applied.
  readonly environmentGaps?: EngineGap[];
  // Checked per configured audit, so an option the engine cannot apply
  // (performance.web conditions outside Chromium) is unsupported too.
  auditUnsupported?(config: AuditConfig): string | null;
  start(timeoutMs: number): Promise<void>;
  setTimeout(timeoutMs: number): void;
  location(): string;
  check(condition: Check): Promise<boolean>;
  // Why a condition does not hold now (its target matches nothing, several
  // elements, or a hidden one; the path differs), for a failure report.
  // Null when it holds or there is nothing more to say. Optional.
  explain?(condition: Check): Promise<string | null>;
  observe(step: number, screenshot: string): Promise<Observation>;
  candidates(): Promise<Action[]>;
  execute(action: Action, before: Observation): Promise<void>;
  // Stable recipient/progress state for loop detection; null disables detection for this action.
  repeatState?(action: Action): Promise<string | null>;
  // Observed-control names of the actions offered by the last candidates() call.
  // Lets the planner see which visible controls the test cannot use.
  offeredControls?(): string[];
  screenshot(path: string): Promise<void>;
  // Whether the session is still inside the journey's scope. Web sessions use
  // URL scope; native drivers check that the target app is frontmost.
  inScope?(): Promise<boolean>;
  // Runs a driver audit (one without a core `evaluate`, see
  // src/audits/registry.ts) and returns its raw output, which the runner
  // parses with auditOutputSchema. Throw for an audit the driver lacks.
  runAudit?(request: DriverAuditRequest): Promise<unknown>;
  // trace: the evidence file actually written, when not the suggested path;
  // null when no trace was captured (disabled by the evidence policy).
  finish(
    trace: string,
  ): Promise<{ video: string | null; trace?: string | null }>;
}

export interface UIDriver {
  openSession(options: SessionOptions): Promise<UISession>;
  // The driver and browser build, for the run identity. Called after a
  // session opened. Drivers without it are recorded as `custom` (or the
  // suite platform's own driver) with no browser.
  environment?(): Promise<DriverEnvironment> | DriverEnvironment;
  close(): Promise<void>;
}
