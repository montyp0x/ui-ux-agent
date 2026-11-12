import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { allowedURL } from './browser.js';
import { playwrightDriver } from './drivers/playwright.js';
import type { EventLogger, UIDriver, UISession } from './drivers/types.js';
import { missingFillEnv, suiteEvidencePolicy } from './contracts.js';
import type {
  Action,
  Journey,
  Observation,
  Plan,
  Result,
  Suite,
} from './contracts.js';
import type { History, Models, PlanContext } from './models.js';
import { reportHTML } from './report.js';
import { UNRESOLVED_LINK, evidenceLinks } from './evidence/links.js';
import { emptyAudits } from './audits/contract.js';
import { JourneyAudits } from './audits/run.js';
import { baselineDirectoryForRun } from './baselines.js';
import { evaluateQuality } from './quality.js';
import {
  OUTCOME_CODES,
  RESULT_VERSION,
  emptySignals,
  type OutcomeCode,
} from './results.js';
import { addModelCall, emptyUsage, summarize, type Usage } from './summary.js';
import { actionSignature, refreshReasons, type PlanState } from './planning.js';
import {
  evidenceProtection,
  type EvidenceProtection,
} from './evidence/protection.js';
import { providerModels } from './evidence/provider.js';
import { redactError } from './evidence/redact.js';
import { restrictPermissions, sanitizeTextFiles } from './evidence/sweep.js';
import { writeRunManifest } from './evidence/retention.js';
import { FrictionRecorder, computeFriction } from './friction/index.js';
import { AUDIT_CONTRACT_VERSION } from './audits/contract.js';
import {
  ENGINE_VERSION,
  IDENTITY_VERSION,
  osIdentity,
  suiteHash,
  suiteTarget,
  type Build,
  type ModelIdentity,
  type RunIdentity,
} from './identity.js';
import {
  DataLifecycleHooks,
  withData,
  type CleanupTrigger,
  type LifecycleRun,
} from './lifecycle.js';

export type RunOptions = {
  directory: string;
  storageState?: string;
  // Dedicated persistent test profile directory, signed in once with
  // --sign-in (see dedicatedProfile); never a personal browser profile.
  profile?: string;
  headless?: boolean;
  video?: boolean;
  journey?: string;
  viewport?: string;
  driver?: UIDriver;
  // Runs per journey/viewport, for pass rates (1-50, default 1).
  repeat?: number;
  // Environment for credential redaction (default process.env): values of
  // the suite's redactEnv variables and of credential-named variables never
  // appear in evidence or model payloads.
  env?: Record<string, string | undefined>;
  // A user-supplied directory of approved visual baselines (outside Git),
  // read by the visual.baseline audit; runs never write into it.
  baselines?: string;
  // Cancels the suite: the current run stops at its next stage, its data
  // cleanup still runs, and no further run starts.
  signal?: AbortSignal;
  // The build or revision under test, recorded in each result's identity
  // as given (--build / UIUX_BUILD); null or omitted records it as unknown.
  build?: Build | null;
  // The model endpoints and names in use (never keys), for the identity;
  // omitted for custom Models implementations.
  modelIdentity?: ModelIdentity | null;
};
export type Logger = EventLogger;

const STALL_STEPS = 5;

// Replaces {{marker}} anywhere in the journey; returns the same object when the
// journey has no placeholder.
export function withMarker(journey: Journey, marker: string): Journey {
  const text = JSON.stringify(journey);
  if (!text.includes('{{marker}}')) return journey;
  return JSON.parse(text.replaceAll('{{marker}}', marker)) as Journey;
}

// A stage that would start after the journey deadline; reported as budget exhaustion.
class BudgetExpired extends Error {}
// The run was cancelled through RunOptions.signal.
class RunCancelled extends Error {}
// The data lifecycle's reset or setup failed; the journey does not start.
class DataSetupFailed extends Error {}
// A planner/selector call that failed, or returned output the runner cannot use.
class ModelFailure extends Error {
  constructor(
    message: string,
    readonly invalidOutput: boolean,
    readonly original: unknown = null,
  ) {
    super(message);
  }
}
// The driver lacks a capability the journey configuration needs.
class DriverCapabilityMissing extends Error {}
// A runner invariant broke; attribution is unknown.
class RunnerInvariant extends Error {}
// Stages whose failures come from the UI driver (or the application behind it).
const DRIVER_STAGES = new Set([
  'start',
  'ready',
  'setup',
  'observe',
  'checks',
  'content',
  'candidates',
  'loop_check',
  'execute',
]);

async function callModel<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (caught) {
    throw new ModelFailure(
      caught instanceof Error ? caught.message : String(caught),
      false,
      caught,
    );
  }
}

// Playwright and AbortSignal.timeout both name their timeout errors TimeoutError.
function isTimeout(caught: unknown): boolean {
  const error = caught instanceof ModelFailure ? caught.original : caught;
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
}

function isAbort(caught: unknown): boolean {
  const error = caught instanceof ModelFailure ? caught.original : caught;
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

// The model limiter's refusal to start a request whose rate-limit cooldown
// ends past the deadline (RateLimitBudgetError in models.ts). Matched by name
// so this module does not depend on the limiter's class.
function isRateLimitBudget(caught: unknown): boolean {
  const error = caught instanceof ModelFailure ? caught.original : caught;
  return (
    error instanceof Error &&
    (error.name === 'RateLimitBudgetError' ||
      error.constructor.name === 'RateLimitBudgetError')
  );
}

const isStale = (error: string) => error.startsWith('Stale observation');

function firstLine(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.split('\n')[0]!.slice(0, 200);
}

async function ready(
  session: UISession,
  journey: Journey,
  deadline: number,
): Promise<boolean> {
  const expires = Math.min(deadline, Date.now() + 10000);
  while (Date.now() < expires) {
    if (await session.check(journey.ready)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function waitForContent(
  session: UISession,
  journey: Journey,
  deadline: number,
  viewport: string,
  log: Logger,
): Promise<{ checks: boolean[]; passed: boolean; journeyBudget: boolean }> {
  const started = Date.now();
  const expires = Math.min(deadline, started + journey.contentReady!.timeoutMs);
  const conditions = journey.contentReady!.checks;
  let checks = conditions.map(() => false);
  while (true) {
    if (Date.now() < expires) {
      session.setTimeout(Math.max(1, Math.min(5000, expires - Date.now())));
      try {
        checks = await Promise.all(
          conditions.map((condition) => session.check(condition)),
        );
      } catch (caught) {
        if (Date.now() < expires) throw caught;
        // Preserve the last complete assertion evidence when a deadline interrupts a poll.
      }
    }
    const passed =
      checks.every(Boolean) && Date.now() < expires && !session.unauthorized;
    const finished = passed || Date.now() >= expires || session.unauthorized;
    await log('content_readiness', {
      journey: journey.id,
      viewport,
      outcome: session.unauthorized
        ? 'unauthorized'
        : passed
          ? 'passed'
          : finished
            ? 'timeout'
            : 'waiting',
      checks,
      failedChecks: conditions.flatMap((condition, index) =>
        checks[index]
          ? []
          : [{ index: journey.success.length + index, condition }],
      ),
      durationMs: Date.now() - started,
      budget: expires === deadline ? 'journey' : 'content',
    });
    if (finished)
      return { checks, passed, journeyBudget: expires === deadline };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(200, expires - Date.now()))),
    );
  }
}

async function runJourney(
  session: UISession,
  suite: Suite,
  journey: Journey,
  viewport: string,
  directory: string,
  models: Models,
  log: Logger,
  attempt: number,
  usage: Usage,
  protection: EvidenceProtection,
  baselines: string | null,
  lifecycle: LifecycleRun | null = null,
  cancel?: AbortSignal,
  // This run's friction-relevant events as written to events.jsonl.
  friction: FrictionRecorder | null = null,
  identity?: RunIdentity,
): Promise<Result> {
  const started = Date.now();
  const deadline = started + journey.maxDurationMs;
  // Aborted at the deadline and passed to every model call, so queued or
  // in-flight planner and selector requests stop there. The reason is a
  // TimeoutError, like AbortSignal.timeout's; a cancelled run aborts it with
  // an AbortError.
  const deadlineAbort = new AbortController();
  const onCancel = () =>
    deadlineAbort.abort(new DOMException('Run cancelled', 'AbortError'));
  if (cancel?.aborted) onCancel();
  else cancel?.addEventListener('abort', onCancel, { once: true });
  // Audits run at their configured checkpoints only, never after every action.
  const audits = new JourneyAudits({
    suite,
    journey,
    viewport: suite.viewports.find((entry) => entry.name === viewport) ?? {
      name: viewport,
      width: 0,
      height: 0,
    },
    directory,
    baselines,
    session,
    log,
  });
  const deadlineTimer = setTimeout(
    () =>
      deadlineAbort.abort(
        new DOMException('Journey deadline reached', 'TimeoutError'),
      ),
    journey.maxDurationMs,
  );
  const result: Result = {
    resultVersion: RESULT_VERSION,
    journey: journey.id,
    viewport,
    attempt,
    usage,
    status: 'error',
    reason: 'Journey did not finish',
    outcome: {
      code: 'journey_not_finished',
      category: 'unknown',
      source: 'unknown',
      stage: 'start',
      step: 0,
      detail: null,
      evidence: { screenshot: null, events: [], failedChecks: [] },
      signals: emptySignals(),
    },
    quality: {
      verdict: 'not_evaluated',
      reason: 'Journey did not finish',
      executed: [],
      skipped: [],
      unsupported: [],
    },
    steps: 0,
    durationMs: 0,
    checks: [],
    findings: [],
    audits: emptyAudits(suite.audits.failOn),
    trace: join(directory, 'trace.zip'),
    video: null,
    evidence: protection.report(0),
    ...(identity ? { identity } : {}),
  };
  let observation: Observation | null = null;
  let plan: Plan | null = null;
  let planState: PlanState | null = null;
  let noMatch = 0;
  let recoveryScrolls = 0;
  const history: History = [];
  const repeats = new Map<string, number>();
  const replanned = new Set<string>();
  // Steps observed on each configured detour, keyed by its index.
  const detourSteps = new Map<number, number>();
  let revisitPending: string | null = null;
  // Consecutive executed actions that stayed on the same page path.
  let dwellSteps = 0;
  const stalledPages = new Set<string>();
  let stage = 'start';
  let staleActions = 0;
  let actionErrors = 0;
  // Observed states measured by the built-in quality checks.
  let measured = 0;
  // final.png once captured, for the completion checkpoint.
  let finalScreenshot: string | null = null;
  // Sets the functional outcome; the code fixes status, category and source.
  const decide = (
    code: OutcomeCode,
    reason: string,
    evidence: {
      step?: number;
      screenshot?: string | null;
      events?: string[];
      detail?: string | null;
    } = {},
  ) => {
    const [status, category, source] = OUTCOME_CODES[code];
    result.status = status;
    result.reason = reason;
    result.outcome = {
      code,
      category,
      source,
      stage,
      step: evidence.step ?? observation?.step ?? result.steps,
      detail: evidence.detail ?? null,
      evidence: {
        screenshot: evidence.screenshot ?? observation?.screenshot ?? null,
        events: evidence.events ?? [],
        failedChecks: result.checks.flatMap((ok, index) => (ok ? [] : [index])),
      },
      signals: result.outcome.signals,
    };
  };
  // Records an observed journey state for the quality checks, then runs the
  // audits whose checkpoint (ready, a declared state) it reaches.
  const measure = async (state: Observation) => {
    measured++;
    audits.record(state);
    await audits.afterObservation(state);
  };
  // Names the stage for budget reporting and refuses to start it after the deadline.
  const inScope = async () =>
    session.inScope
      ? session.inScope()
      : allowedURL(
          session.location(),
          suite.baseURL,
          journey.allowedPaths,
          suite.allowedOrigins,
        );
  const remaining = (next: string): number => {
    stage = next;
    if (cancel?.aborted) throw new RunCancelled();
    if (Date.now() >= deadline) throw new BudgetExpired();
    return deadline - Date.now();
  };
  try {
    if (lifecycle?.setupFailure) {
      stage = 'setup';
      throw new DataSetupFailed(lifecycle.setupFailure);
    }
    if (cancel?.aborted) throw new RunCancelled();
    if (journey.loopProgressTargets?.length && !session.repeatState)
      throw new DriverCapabilityMissing(
        'Driver must implement repeatState to support loopProgressTargets',
      );
    await session.start(Math.min(15000, journey.maxDurationMs));
    stage = 'ready';
    let setupProblem: string | null = null;
    let setupCode: OutcomeCode = 'ready_not_reached';
    let setupScreenshot: string | null = null;
    let setupError: string | null = null;
    if (await ready(session, journey, deadline))
      for (const [index, setup] of (journey.setup ?? []).entries()) {
        stage = 'setup';
        session.setTimeout(Math.max(1, Math.min(5000, deadline - Date.now())));
        const before = await session.observe(
          -1,
          join(directory, `setup-${String(index).padStart(2, '0')}.png`),
        );
        const offered = (await session.candidates()).find(
          (action) =>
            action.kind === setup.kind &&
            'target' in action &&
            JSON.stringify(action.target) === JSON.stringify(setup.target),
        );
        let error: string | null = offered
          ? null
          : 'not offered (missing, hidden, disabled or blocked)';
        if (offered)
          try {
            // The guarded object itself: guards are keyed by the offered action.
            await session.execute(offered, before);
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
          }
        await log('setup', {
          journey: journey.id,
          viewport,
          index,
          description: setup.description,
          error,
        });
        if (error) {
          setupProblem = `Setup step ${index + 1} (${setup.description}) failed: ${error}`;
          setupCode = !offered
            ? 'setup_not_offered'
            : isStale(error)
              ? 'setup_stale_action'
              : 'setup_action_failed';
          if (setupCode === 'setup_stale_action') staleActions++;
          setupScreenshot = before.screenshot;
          setupError = error;
          break;
        }
      }
    else setupProblem = 'ready';
    if (setupProblem) {
      if (setupProblem === 'ready')
        decide(
          'ready_not_reached',
          'Ready assertion was not reached: check authentication, data prerequisites, or the configured selector',
          { step: -1 },
        );
      else
        decide(setupCode, setupProblem, {
          step: -1,
          screenshot: setupScreenshot,
          events: ['setup'],
          detail: setupError,
        });
    } else {
      for (let step = 0; step <= journey.maxSteps; step++) {
        session.setTimeout(Math.max(1, Math.min(5000, deadline - Date.now())));
        stage = 'observe';
        observation = await session.observe(
          step,
          join(directory, `step-${String(step).padStart(3, '0')}.png`),
        );
        await log('observation', {
          journey: journey.id,
          viewport,
          ...observation,
        });
        await measure(observation);
        const pathname = new URL(observation.url).pathname;
        for (const [index, detour] of (journey.detours ?? []).entries()) {
          if (!new RegExp(detour.pattern).test(pathname)) continue;
          const seen = (detourSteps.get(index) ?? 0) + 1;
          detourSteps.set(index, seen);
          await log('detour', {
            journey: journey.id,
            viewport,
            step,
            path: pathname,
            description: detour.description,
            visits: seen,
          });
          if (seen === 1)
            result.findings.push({
              kind: 'observed',
              category: 'detour',
              description: `Reached ${pathname}: ${detour.description}`,
              step,
              screenshot: observation.screenshot,
            });
        }
        if (session.unauthorized) {
          decide(
            'unauthorized_response',
            'An authenticated request returned 401',
            {
              events: ['observation'],
            },
          );
          break;
        }
        stage = 'checks';
        result.checks = await Promise.all(
          journey.success.map((condition) => session.check(condition)),
        );
        if (result.checks.every(Boolean)) {
          stage = 'content';
          const completion = journey.contentReady
            ? await waitForContent(session, journey, deadline, viewport, log)
            : {
                checks: [],
                passed: Date.now() < deadline,
                journeyBudget: true,
              };
          if (completion.passed && journey.contentReady) {
            // Loading can move arrival controls below the viewport. Refresh before planning.
            observation = await session.observe(step, observation.screenshot);
            await log('content_observation', {
              journey: journey.id,
              viewport,
              ...observation,
            });
            await measure(observation);
            result.checks = await Promise.all(
              journey.success.map((condition) => session.check(condition)),
            );
          }
          result.checks = [...result.checks, ...completion.checks];
          if (
            session.unauthorized ||
            !completion.passed ||
            (result.checks.every(Boolean) && Date.now() < deadline)
          ) {
            const events = journey.contentReady
              ? ['observation', 'content_readiness']
              : ['observation'];
            if (session.unauthorized)
              decide(
                'unauthorized_response',
                'An authenticated request returned 401',
                { events },
              );
            else if (completion.passed)
              decide(
                'assertions_passed',
                'All independent outcome assertions passed',
                { events },
              );
            else if (journey.contentReady)
              // A content wait cut short by the journey deadline is a budget
              // outcome, not evidence that the content never appears.
              decide(
                completion.journeyBudget
                  ? 'budget_deadline'
                  : 'content_readiness_timeout',
                'Content readiness timed out before the configured content assertions passed',
                { events },
              );
            else
              decide(
                'budget_deadline',
                'Task budget exhausted before the outcome was observed',
                { events },
              );
            break;
          }
        }
        if (!(await inScope())) {
          decide('scope_exit', 'Navigation left the allowed journey scope', {
            events: ['observation'],
          });
          break;
        }
        if (Date.now() >= deadline || step === journey.maxSteps) {
          decide(
            step === journey.maxSteps ? 'budget_max_steps' : 'budget_deadline',
            'Task budget exhausted before the outcome was observed',
            { events: ['observation'] },
          );
          break;
        }
        stage = 'candidates';
        const actions = await session.candidates();
        const currentPlanState = {
          url: observation.url,
          actions: actionSignature(actions),
          step,
        };
        const reasons = refreshReasons(
          !!plan,
          planState,
          currentPlanState,
          history,
        );
        const revisitedAction: string | null = plan ? revisitPending : null;
        if (revisitedAction) reasons.push('revisited-state');
        revisitPending = null;
        // Every STALL_STEPS actions that stayed on one page, ask the planner to
        // reconsider whether this page can satisfy the goal. Only the count is
        // shared: being asked again already implies the goal is not reached.
        const stalled: boolean =
          !!plan && dwellSteps > 0 && dwellSteps % STALL_STEPS === 0;
        if (stalled) {
          reasons.push('stalled');
          stalledPages.add(new URL(observation.url).pathname);
        }
        if (reasons.length) {
          const planBudget = remaining('plan');
          const planned = observation;
          const context: PlanContext = {
            reasons,
            ...(revisitedAction ? { revisitedAction } : {}),
            ...(stalled ? { stalledSteps: dwellSteps } : {}),
            ...(stalledPages.size ? { stalledPages: [...stalledPages] } : {}),
            ...(session.offeredControls
              ? { offeredControls: session.offeredControls() }
              : {}),
          };
          plan = await callModel<Plan>(() =>
            models.plan(
              journey,
              planned,
              history,
              planBudget,
              actions,
              context,
              deadlineAbort.signal,
            ),
          );
          planState = currentPlanState;
          await log('plan', {
            journey: journey.id,
            viewport,
            step,
            plan,
            refreshReasons: reasons,
          });
          for (const concern of plan.concerns)
            result.findings.push({
              kind: 'hypothesis',
              category: 'usability',
              description: `${concern.symptom}. User impact: ${concern.userImpact}`,
              step,
              screenshot: observation.screenshot,
            });
        }
        if (!plan)
          throw new RunnerInvariant('Planner did not produce an objective');
        const chooseBudget = remaining('choose');
        const [observed, current] = [observation, plan];
        const decision = await callModel(() =>
          models.choose(
            journey,
            observed,
            current,
            actions,
            history,
            chooseBudget,
            deadlineAbort.signal,
          ),
        );
        await log('decision', {
          journey: journey.id,
          viewport,
          step,
          candidates: actions,
          decision,
        });
        let action: Action | undefined;
        const source = decision.choice === 'no_match' ? 'recovery' : 'selector';
        if (decision.choice === 'no_match') {
          plan = null;
          if (++noMatch < 2) continue;
          action = actions.find(
            (candidate) =>
              candidate.kind === 'scroll' && candidate.direction === 'down',
          );
          if (!action || recoveryScrolls >= 2) {
            decide(
              'selector_no_path',
              'Selector could not find a path after bounded scroll recovery',
              { events: ['decision', 'recovery'] },
            );
            break;
          }
          recoveryScrolls++;
          await log('recovery', {
            journey: journey.id,
            viewport,
            step,
            reason: 'Two consecutive no_match decisions',
            attempt: recoveryScrolls,
            limit: 2,
            action,
          });
          result.findings.push({
            kind: 'observed',
            category: 'selector-recovery',
            description: `Selector returned no_match twice; runner attempted downward scroll recovery ${recoveryScrolls}/2`,
            step,
            screenshot: observation.screenshot,
          });
        } else {
          action = actions.find(
            (candidate) => candidate.id === decision.choice,
          );
        }
        noMatch = 0;
        if (!action)
          throw new ModelFailure('Selected action was not offered', true);
        stage = 'loop_check';
        const state =
          action.kind === 'wait'
            ? null
            : session.repeatState
              ? await session.repeatState(action)
              : observation.fingerprint;
        if (state !== null) {
          const repeatKey = createHash('sha256')
            .update(
              JSON.stringify([state, actionSignature([action]), result.checks]),
            )
            .digest('hex');
          const prior = repeats.get(repeatKey) ?? 0;
          const loopCheck = {
            journey: journey.id,
            viewport,
            step,
            action: action.description,
            stateSource: session.repeatState ? 'recipient' : 'page-fallback',
            key: repeatKey,
            visits: prior + 1,
            limit: 3,
            progressTargets: journey.loopProgressTargets?.length ?? 0,
          };
          // A revisit means the current objective led back to a tried state, which
          // offered actions alone may not reveal. Ask the planner once per state
          // before dispatching it again; the visit limit below is unchanged.
          if (
            prior >= 1 &&
            source === 'selector' &&
            !replanned.has(repeatKey)
          ) {
            replanned.add(repeatKey);
            revisitPending = action.description;
            await log('loop_check', { ...loopCheck, outcome: 'replan' });
            continue;
          }
          const repeated = prior + 1;
          repeats.set(repeatKey, repeated);
          await log('loop_check', {
            ...loopCheck,
            outcome: repeated >= 3 ? 'rejected' : 'dispatch',
          });
          if (repeated >= 3) {
            decide(
              'repeated_action',
              session.repeatState
                ? 'Repeated the same action in the same recipient/progress state three times'
                : 'Repeated the same action in the same page state three times',
              { events: ['loop_check'], detail: action.description },
            );
            result.findings.push({
              kind: 'observed',
              category: 'loop',
              description: `Repeated action: ${action.description}; ${session.repeatState ? 'recipient and declared progress' : 'page'} state revisited three times`,
              step,
              screenshot: observation.screenshot,
            });
            break;
          }
        }
        let error: string | null = null;
        let budgetCut = false;
        remaining('execute');
        const actionStarted = Date.now();
        try {
          await session.execute(action, observation);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          budgetCut = isTimeout(caught) && Date.now() >= deadline;
        }
        stage = 'observe';
        const after = await session.observe(
          step + 1,
          join(directory, `step-${String(step + 1).padStart(3, '0')}.png`),
        );
        const changed = after.fingerprint !== observation.fingerprint;
        dwellSteps =
          new URL(after.url).pathname === new URL(observation.url).pathname
            ? dwellSteps + 1
            : 0;
        history.push({ action: action.description, changed, error });
        result.steps++;
        await log('action_result', {
          journey: journey.id,
          viewport,
          step,
          action,
          source,
          changed,
          error,
          durationMs: Date.now() - actionStarted,
        });
        if (error && isStale(error)) staleActions++;
        if (
          source === 'recovery' &&
          !error &&
          JSON.stringify(after.scroll) === JSON.stringify(observation.scroll)
        ) {
          decide(
            'recovery_scroll_stalled',
            'Selector recovery scroll did not advance the viewport',
            {
              step: after.step,
              screenshot: after.screenshot,
              events: ['action_result'],
            },
          );
          break;
        }
        // A timeout cut short by the journey deadline is not a UI defect.
        if (error && !isStale(error) && !budgetCut) {
          actionErrors++;
          result.findings.push({
            kind: 'observed',
            category: 'action-error',
            description: `${action.description}: ${error}`,
            step: step + 1,
            screenshot: after.screenshot,
          });
        }
        if (!(await inScope())) {
          decide('scope_exit', 'Navigation left the allowed journey scope', {
            step: after.step,
            screenshot: after.screenshot,
            events: ['action_result'],
          });
          break;
        }
      }
    }
  } catch (caught) {
    const notStarted = caught instanceof BudgetExpired;
    const cancelled = !!cancel?.aborted || caught instanceof RunCancelled;
    // A model call that ended at the deadline is one outcome whichever fired
    // first: the journey signal, the call's own timeout, or the limiter's
    // slot wait expiring (RateLimitBudgetError).
    const deadlineCut =
      caught instanceof ModelFailure &&
      (deadlineAbort.signal.aborted || Date.now() >= deadline) &&
      (isTimeout(caught) || isAbort(caught) || isRateLimitBudget(caught));
    const rateLimited = !deadlineCut && isRateLimitBudget(caught);
    if (caught instanceof DataSetupFailed) {
      decide('data_setup_failed', caught.message, {
        step: -1,
        events: ['data_setup'],
        detail: firstLine(caught),
      });
    } else if (cancelled) {
      decide(
        'run_cancelled',
        `The run was cancelled during ${stage} before its outcome was observed`,
        { events: ['run_cancelled'] },
      );
      await log('run_cancelled', {
        journey: journey.id,
        viewport,
        step: result.steps,
        stage,
      });
    } else if (
      !session.unauthorized &&
      (notStarted ||
        deadlineCut ||
        rateLimited ||
        (isTimeout(caught) && Date.now() >= deadline))
    ) {
      const [code, cause, why]: [OutcomeCode, string, string] = notStarted
        ? [
            'budget_deadline_before_stage',
            'deadline_before_stage',
            `deadline reached before ${stage}`,
          ]
        : deadlineCut
          ? [
              'budget_deadline_abort',
              'deadline_abort',
              `${stage} was cancelled at the deadline`,
            ]
          : rateLimited
            ? [
                'budget_model_rate_limit',
                'rate_limit',
                `${stage} would wait for the model rate limit past the deadline`,
              ]
            : [
                'budget_stage_timeout',
                'timeout',
                `${stage} timed out at the deadline`,
              ];
      const detail = notStarted ? null : firstLine(caught);
      decide(
        code,
        `Task budget exhausted before the outcome was observed (${why})`,
        { events: ['budget_exhausted'], detail },
      );
      await log('budget_exhausted', {
        journey: journey.id,
        viewport,
        step: result.steps,
        stage,
        cause,
        detail,
        overrunMs: Date.now() - deadline,
      });
    } else {
      const message = caught instanceof Error ? caught.message : String(caught);
      decide(
        session.unauthorized
          ? 'unauthorized_response'
          : caught instanceof ModelFailure
            ? caught.invalidOutput
              ? 'model_invalid_output'
              : 'model_call_failed'
            : caught instanceof DriverCapabilityMissing
              ? 'driver_capability_missing'
              : caught instanceof RunnerInvariant || !DRIVER_STAGES.has(stage)
                ? 'unclassified_error'
                : 'driver_error',
        message,
        {
          detail: firstLine(caught),
          // The decision event holds the selector's unusable choice.
          events:
            caught instanceof ModelFailure && caught.invalidOutput
              ? ['decision']
              : [],
        },
      );
    }
  } finally {
    clearTimeout(deadlineTimer);
    cancel?.removeEventListener('abort', onCancel);
    let evidenceComplete = false;
    try {
      // Evidence capture has its own bounded timeout, not the expired task timeout.
      session.setTimeout(5000);
      const screenshot = join(directory, 'final.png');
      await session.screenshot(screenshot);
      finalScreenshot = screenshot;
      for (const [index, steps] of detourSteps) {
        const finding = result.findings.find(
          (entry) =>
            entry.category === 'detour' &&
            entry.description.endsWith(journey.detours![index]!.description),
        );
        if (finding)
          finding.description += ` (${steps} observed step${steps === 1 ? '' : 's'} there)`;
      }
      for (const block of new Set(session.policyBlocks ?? []))
        result.findings.push({
          kind: 'observed',
          category: 'policy-block',
          description: `Test request policy blocked ${block}. The page may show errors caused by the test harness, not the application; if this is a read, add it to readOnlyPosts.`,
          step: result.steps,
          screenshot,
        });
      for (const error of new Set(session.browserErrors))
        result.findings.push({
          kind: 'observed',
          category: 'browser-error',
          description: error,
          step: result.steps,
          screenshot,
        });
      if (!result.findings.length)
        result.findings.push({
          kind: 'observed',
          category: 'final-state',
          description: result.reason,
          step: result.steps,
          screenshot,
        });
      result.outcome.evidence.screenshot ??= screenshot;
      evidenceComplete = true;
    } catch (caught) {
      stage = 'finish';
      decide(
        'evidence_capture_failed',
        `${result.reason}; evidence capture failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        { detail: `${firstLine(caught)} (after ${result.outcome.code})` },
      );
    }
    // The completion checkpoint: the final state, before the session closes.
    await audits.completion(result.steps, finalScreenshot);
    result.audits = audits.finish();
    try {
      const finished = await session.finish(join(directory, 'trace.zip'));
      result.video = finished.video;
      if (finished.trace !== undefined) result.trace = finished.trace;
    } catch (caught) {
      stage = 'finish';
      decide(
        'session_cleanup_failed',
        `${result.reason}; session cleanup failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        { detail: `${firstLine(caught)} (after ${result.outcome.code})` },
      );
    }
    // Data cleanup runs after the browser session closed, whatever ended
    // the run; its failure is reported, never hidden behind the outcome.
    if (lifecycle) {
      await lifecycle.cleanup(cleanupTrigger(result));
      result.dataLifecycle = lifecycle.record;
      if (!lifecycle.record.clean)
        result.findings.push({
          kind: 'observed',
          category: 'data-cleanup',
          description: `Data cleanup failed for run ${lifecycle.record.run} on ${lifecycle.record.service}: ${lifecycle.record.cleanup?.detail ?? 'cleanup did not run'}. Test data may remain; clean it up before the next run.`,
          step: result.steps,
          screenshot: finalScreenshot ?? join(directory, 'final.png'),
        });
    }
    // Task friction from the events this run wrote (already redacted), so it
    // reconciles exactly with events.jsonl. Descriptive only: computed after
    // the outcome and never read by the quality verdict.
    if (friction) result.friction = computeFriction(friction, journey);
    const policyBlocks = new Set(session.policyBlocks ?? []).size;
    result.outcome.signals = {
      staleActions,
      actionErrors,
      policyBlocks,
      browserErrors: new Set(session.browserErrors).size,
    };
    result.quality = evaluateQuality({
      platform: suite.platform,
      observations: measured,
      findings: result.findings,
      policyBlocks,
      evidenceComplete,
      audits: result.audits,
    });
    result.durationMs = Date.now() - started;
    // Files drivers and audits wrote (measurements, the native tree) get the
    // run's redaction, then the result itself is redacted before it is written
    // or returned.
    const resultFile = join(directory, 'result.json');
    const rewritten = await sanitizeTextFiles(
      directory,
      protection.redactor,
      new Set([resultFile]),
    );
    result.evidence = protection.report(rewritten.length);
    Object.assign(result, protection.redactor.deep(result));
    await writeFile(resultFile, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    await restrictPermissions(directory);
    await log('journey_finished', result);
  }
  return result;
}

// What ended a run, as the data cleanup hook is told.
export function cleanupTrigger(result: Result): CleanupTrigger {
  if (result.outcome.code === 'run_cancelled') return 'cancelled';
  if (result.outcome.category === 'budget_exhausted') return 'timeout';
  return result.status;
}

export async function runSuite(
  suite: Suite,
  models: Models | ((log: Logger) => Models),
  options: RunOptions,
): Promise<Result[]> {
  if (suite.requiresAuth && !options.storageState && !options.profile)
    throw new Error(
      'This suite requires a signed-in --profile or an approved storage-state path',
    );
  const journeys = suite.journeys.filter(
    (journey) => !options.journey || journey.id === options.journey,
  );
  // Fail before any run, naming every unset variable a fill reads.
  const unset = missingFillEnv({ journeys });
  if (unset.length)
    throw new Error(
      `Set the environment variable${unset.length > 1 ? 's' : ''} ${unset.join(', ')} read by fill valueEnv`,
    );
  const viewports = suite.viewports.filter(
    (viewport) => !options.viewport || viewport.name === options.viewport,
  );
  if (!journeys.length || !viewports.length)
    throw new Error('No matching journey or viewport');
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50)
    throw new Error('repeat must be an integer from 1 to 50');
  // Checked before the run starts: an existing directory outside Git.
  const baselines = options.baselines
    ? await baselineDirectoryForRun(options.baselines)
    : null;
  await mkdir(dirname(options.directory), { recursive: true, mode: 0o700 });
  // Not recursive: an existing run directory is never reused or overwritten.
  await mkdir(options.directory, { mode: 0o700 });
  // The suite's evidence policy with every fill valueEnv and secret setup
  // value as a secret.
  const policy = suiteEvidencePolicy(suite);
  await writeRunManifest(options.directory, policy.retentionDays);
  const protection = evidenceProtection(
    policy,
    {
      ...(options.env ?? process.env),
      // Fills read process.env (fillValue): their values are redacted from
      // the same source, whatever environment the caller passed.
      ...Object.fromEntries(
        policy.redactEnv
          .filter((name) => !suite.evidence.redactEnv.includes(name))
          .flatMap((name) =>
            process.env[name] === undefined ? [] : [[name, process.env[name]]],
          ),
      ),
    },
    {
      platform: suite.platform,
      authenticated: !!(options.storageState || options.profile),
      videoRequested: !!options.video,
    },
  );
  const { redactor } = protection;
  // Journeys run one at a time, so model calls and friction events belong
  // to the current run.
  let currentUsage: Usage | null = null;
  let currentFriction: FrictionRecorder | null = null;
  // Writes are serialized, so each event lands on the line it was numbered
  // with, even when a driver logs without awaiting.
  let lines = 0;
  let written: Promise<void> = Promise.resolve();
  const log: Logger = async (event, data) => {
    if (event === 'model_call' && currentUsage)
      addModelCall(currentUsage, data);
    // Every event is redacted before it is written: page text, errors,
    // model responses and audit output alike.
    const redacted = redactor.deep(data);
    const line = ++lines;
    currentFriction?.record(line, event, redacted);
    const text =
      JSON.stringify({ time: new Date().toISOString(), event, data: redacted }) +
      '\n';
    const write = written.then(() =>
      appendFile(join(options.directory, 'events.jsonl'), text, {
        mode: 0o600,
      }),
    );
    written = write.catch(() => undefined);
    await write;
  };
  // Model adapters receive only the redacted, provider-visible view.
  const engine = providerModels(
    typeof models === 'function' ? models(log) : models,
    protection,
  );
  await log('evidence_policy', protection.report(0));
  await writeFile(
    join(options.directory, 'suite.json'),
    JSON.stringify(redactor.deep(suite), null, 2),
    { mode: 0o600 },
  );
  const driver =
    options.driver ??
    (suite.platform === 'macos'
      ? await (await import('./drivers/macos.js')).macosDriver()
      : await playwrightDriver(
          suite.browser,
          options.headless ?? true,
          suite,
          options.profile,
        ));
  // What every run of this suite measures, for comparisons (src/compare.ts).
  // The driver's environment is read once a session has opened.
  const identityFor = async (): Promise<RunIdentity> => ({
    identityVersion: IDENTITY_VERSION,
    build: options.build ?? null,
    suite: {
      name: suite.name,
      hash: suiteHash(suite, redactor),
      target: suiteTarget(suite.baseURL),
      selection: {
        journeys: journeys.map((journey) => journey.id),
        viewports: viewports.map((viewport) => viewport.name),
        repeat,
      },
    },
    engine: {
      version: ENGINE_VERSION,
      resultVersion: RESULT_VERSION,
      auditContractVersion: AUDIT_CONTRACT_VERSION,
    },
    environment: {
      platform: suite.platform,
      ...((await driver.environment?.()) ?? {
        driver: options.driver
          ? 'custom'
          : suite.platform === 'macos'
            ? 'macos'
            : 'playwright',
        browser: null,
      }),
      os: osIdentity(),
      node: process.versions.node,
    },
    models: options.modelIdentity ?? null,
  });
  const results: Result[] = [];
  // The report links every file it shows; paths the redaction rewrote in the
  // results are resolved to the files they name (src/evidence/links.ts).
  const report = async (name: string, shown: Result[]) => {
    const files = new Set<string>();
    reportHTML(name, shown, options.directory, (file) => {
      files.add(file);
      return '';
    });
    const links = await evidenceLinks(
      options.directory,
      redactor,
      files,
      baselines ? [baselines] : [],
    );
    return reportHTML(
      name,
      shown,
      options.directory,
      (file) => links.get(file) ?? UNRESOLVED_LINK,
    );
  };
  const lifecycle = suite.dataLifecycle
    ? new DataLifecycleHooks(suite.dataLifecycle, log)
    : null;
  try {
    runs: for (const journey of journeys) {
      for (const viewport of viewports) {
        for (let attempt = 1; attempt <= repeat; attempt++) {
          if (options.signal?.aborted) break runs;
          const directory = join(
            options.directory,
            repeat > 1
              ? `${journey.id}-${viewport.name}-${attempt}`
              : `${journey.id}-${viewport.name}`,
          );
          await mkdir(directory, { mode: 0o700 });
          // A unique marker per run, substituted for {{marker}} in the journey
          // (typed values, checks), so a run's own effects can be traced.
          const marker =
            `UIUX-${journey.id}-${attempt}-${Date.now().toString(36)}`.toUpperCase();
          let runJourneyConfig = withMarker(journey, marker);
          // Reset (once) and setup run before the session; setup's values
          // replace {{data.<key>}}.
          const data = lifecycle
            ? await lifecycle.begin(marker, {
                journey: journey.id,
                viewport: viewport.name,
              })
            : null;
          // Setup values (except publicValues) are secrets from here on:
          // redacted from every event, result and file, masked in screenshots.
          protection.beginRun(
            data?.values ?? {},
            suite.dataLifecycle?.publicValues ?? [],
          );
          if (data) {
            const filled = withData(runJourneyConfig, data.values);
            if (filled.missing && !data.setupFailure)
              data.missingValue(filled.missing);
            runJourneyConfig = filled.journey;
          }
          const friction = new FrictionRecorder();
          currentFriction = friction;
          await log('journey_start', {
            journey: journey.id,
            viewport: viewport.name,
            attempt,
            ...(runJourneyConfig !== journey || data ? { marker } : {}),
          });
          try {
            const session = await driver.openSession({
              suite,
              journey: runJourneyConfig,
              viewport,
              directory,
              storageState: options.storageState,
              video: options.video,
              log,
              evidence: protection,
            });
            const usage = emptyUsage();
            currentUsage = usage;
            try {
              const result = await runJourney(
                session,
                suite,
                runJourneyConfig,
                viewport.name,
                directory,
                engine,
                log,
                attempt,
                usage,
                protection,
                baselines,
                data,
                options.signal,
                friction,
                await identityFor(),
              );
              if (runJourneyConfig !== journey || data) result.marker = marker;
              results.push(result);
            } finally {
              currentUsage = null;
              currentFriction = null;
            }
          } finally {
            // A run that never produced a result (the session failed to
            // open) still cleans up; a no-op once runJourney cleaned up.
            await data?.cleanup('error');
          }
          await writeFile(
            join(options.directory, 'results.json'),
            JSON.stringify(results, null, 2),
            { mode: 0o600 },
          );
          await writeFile(
            join(options.directory, 'summary.json'),
            JSON.stringify(summarize(results), null, 2),
            { mode: 0o600 },
          );
          await writeFile(
            join(options.directory, 'report.html'),
            await report(redactor.text(suite.name), results),
            { mode: 0o600 },
          );
        }
      }
    }
  } catch (caught) {
    // Errors can quote the journey, the page or a hook's reply, which can
    // hold a setup value only this run's redactor knows.
    throw redactError(caught, redactor);
  } finally {
    try {
      await driver.close();
    } finally {
      // Last pass over the whole run directory, failed and cancelled runs
      // included, even when the browser did not close cleanly.
      await sanitizeTextFiles(options.directory, redactor);
      await restrictPermissions(options.directory);
    }
  }
  return results;
}
