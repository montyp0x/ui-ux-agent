import type {
  Action,
  Check,
  Journey,
  Observation,
  Suite,
} from '../contracts.js';

export type EventLogger = (event: string, data: unknown) => Promise<void>;
export type SessionOptions = {
  suite: Suite;
  journey: Journey;
  viewport: { width: number; height: number };
  directory: string;
  storageState?: string;
  video?: boolean;
  log: EventLogger;
};

export interface UISession {
  readonly browserErrors: string[];
  // Non-navigation requests to the suite's own origins that the request policy
  // blocked, as "METHOD origin/path".
  readonly policyBlocks?: string[];
  readonly unauthorized: boolean;
  start(timeoutMs: number): Promise<void>;
  setTimeout(timeoutMs: number): void;
  location(): string;
  check(condition: Check): Promise<boolean>;
  observe(step: number, screenshot: string): Promise<Observation>;
  candidates(): Promise<Action[]>;
  execute(action: Action, before: Observation): Promise<void>;
  // Stable recipient/progress state for loop detection; null disables detection for this action.
  repeatState?(action: Action): Promise<string | null>;
  // Observed-control names of the actions offered by the last candidates() call.
  // Lets the planner see which visible controls the test cannot use.
  offeredControls?(): string[];
  screenshot(path: string): Promise<void>;
  finish(trace: string): Promise<{ video: string | null }>;
}

export interface UIDriver {
  openSession(options: SessionOptions): Promise<UISession>;
  close(): Promise<void>;
}
