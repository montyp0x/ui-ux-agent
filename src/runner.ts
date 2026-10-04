import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { allowedURL } from './browser.js';
import { playwrightDriver } from './drivers/playwright.js';
import type { EventLogger, UIDriver, UISession } from './drivers/types.js';
import type {
  Action,
  Journey,
  Observation,
  Plan,
  Result,
  Suite,
} from './contracts.js';
import type { History, Models } from './models.js';
import { reportHTML } from './report.js';
import { actionSignature, refreshReasons, type PlanState } from './planning.js';

export type RunOptions = {
  directory: string;
  storageState?: string;
  headless?: boolean;
  video?: boolean;
  journey?: string;
  viewport?: string;
  driver?: UIDriver;
};
export type Logger = EventLogger;

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
): Promise<{ checks: boolean[]; passed: boolean }> {
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
    if (finished) return { checks, passed };
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
): Promise<Result> {
  const started = Date.now();
  const deadline = started + journey.maxDurationMs;
  const result: Result = {
    journey: journey.id,
    viewport,
    status: 'error',
    reason: 'Journey did not finish',
    steps: 0,
    durationMs: 0,
    checks: [],
    findings: [],
    trace: join(directory, 'trace.zip'),
    video: null,
  };
  let observation: Observation | null = null;
  let plan: Plan | null = null;
  let planState: PlanState | null = null;
  let noMatch = 0;
  let recoveryScrolls = 0;
  const history: History = [];
  const repeats = new Map<string, number>();
  try {
    if (journey.loopProgressTargets?.length && !session.repeatState)
      throw new Error(
        'Driver must implement repeatState to support loopProgressTargets',
      );
    await session.start(Math.min(15000, journey.maxDurationMs));
    if (!(await ready(session, journey, deadline))) {
      result.status = 'blocked';
      result.reason =
        'Ready assertion was not reached: check authentication, data prerequisites, or the configured selector';
    } else {
      for (let step = 0; step <= journey.maxSteps; step++) {
        session.setTimeout(Math.max(1, Math.min(5000, deadline - Date.now())));
        observation = await session.observe(
          step,
          join(directory, `step-${String(step).padStart(3, '0')}.png`),
        );
        await log('observation', {
          journey: journey.id,
          viewport,
          ...observation,
        });
        if (session.unauthorized) {
          result.status = 'blocked';
          result.reason = 'An authenticated request returned 401';
          break;
        }
        result.checks = await Promise.all(
          journey.success.map((condition) => session.check(condition)),
        );
        if (result.checks.every(Boolean)) {
          const completion = journey.contentReady
            ? await waitForContent(session, journey, deadline, viewport, log)
            : { checks: [], passed: Date.now() < deadline };
          if (completion.passed && journey.contentReady) {
            // Loading can move arrival controls below the viewport. Refresh before planning.
            observation = await session.observe(step, observation.screenshot);
            await log('content_observation', {
              journey: journey.id,
              viewport,
              ...observation,
            });
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
            result.status = session.unauthorized
              ? 'blocked'
              : completion.passed
                ? 'passed'
                : 'failed';
            result.reason = session.unauthorized
              ? 'An authenticated request returned 401'
              : completion.passed
                ? 'All independent outcome assertions passed'
                : journey.contentReady
                  ? 'Content readiness timed out before the configured content assertions passed'
                  : 'Task budget exhausted before the outcome was observed';
            break;
          }
        }
        if (
          !allowedURL(
            session.location(),
            suite.baseURL,
            journey.allowedPaths,
            suite.allowedOrigins,
          )
        ) {
          result.status = 'blocked';
          result.reason = 'Navigation left the allowed journey scope';
          break;
        }
        if (Date.now() >= deadline || step === journey.maxSteps) {
          result.status = 'failed';
          result.reason =
            'Task budget exhausted before the outcome was observed';
          break;
        }
        if (
          observation.horizontalOverflow > 1 &&
          !result.findings.some((finding) => finding.category === 'overflow')
        )
          result.findings.push({
            kind: 'observed',
            category: 'overflow',
            description: `Document is ${observation.horizontalOverflow}px wider than the viewport; review whether the horizontal overflow is intentional`,
            step,
            screenshot: observation.screenshot,
          });
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
        if (reasons.length) {
          plan = await models.plan(
            journey,
            observation,
            history,
            deadline - Date.now(),
            actions,
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
        if (!plan) throw new Error('Planner did not produce an objective');
        const decision = await models.choose(
          journey,
          observation,
          plan,
          actions,
          history,
          deadline - Date.now(),
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
            result.status = 'failed';
            result.reason =
              'Selector could not find a path after bounded scroll recovery';
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
        if (!action) throw new Error('Selected action was not offered');
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
          const repeated = (repeats.get(repeatKey) ?? 0) + 1;
          repeats.set(repeatKey, repeated);
          await log('loop_check', {
            journey: journey.id,
            viewport,
            step,
            action: action.description,
            stateSource: session.repeatState ? 'recipient' : 'page-fallback',
            key: repeatKey,
            visits: repeated,
            limit: 3,
            progressTargets: journey.loopProgressTargets?.length ?? 0,
          });
          if (repeated >= 3) {
            result.status = 'failed';
            result.reason = session.repeatState
              ? 'Repeated the same action in the same recipient/progress state three times'
              : 'Repeated the same action in the same page state three times';
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
        const actionStarted = Date.now();
        try {
          await session.execute(action, observation);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const after = await session.observe(
          step + 1,
          join(directory, `step-${String(step + 1).padStart(3, '0')}.png`),
        );
        const changed = after.fingerprint !== observation.fingerprint;
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
        if (
          source === 'recovery' &&
          !error &&
          JSON.stringify(after.scroll) === JSON.stringify(observation.scroll)
        ) {
          result.status = 'failed';
          result.reason =
            'Selector recovery scroll did not advance the viewport';
          break;
        }
        if (error && !error.startsWith('Stale observation'))
          result.findings.push({
            kind: 'observed',
            category: 'action-error',
            description: `${action.description}: ${error}`,
            step: step + 1,
            screenshot: after.screenshot,
          });
        if (
          !allowedURL(
            session.location(),
            suite.baseURL,
            journey.allowedPaths,
            suite.allowedOrigins,
          )
        ) {
          result.status = 'blocked';
          result.reason = 'Navigation left the allowed journey scope';
          break;
        }
      }
    }
  } catch (caught) {
    result.reason = caught instanceof Error ? caught.message : String(caught);
    result.status = session.unauthorized ? 'blocked' : 'error';
  } finally {
    try {
      // Evidence capture has its own bounded timeout, not the expired task timeout.
      session.setTimeout(5000);
      const screenshot = join(directory, 'final.png');
      await session.screenshot(screenshot);
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
    } catch (caught) {
      result.status = 'error';
      result.reason += `; evidence capture failed: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
    try {
      result.video = (await session.finish(result.trace)).video;
    } catch (caught) {
      result.status = 'error';
      result.reason += `; session cleanup failed: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
    result.durationMs = Date.now() - started;
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    await log('journey_finished', result);
  }
  return result;
}

export async function runSuite(
  suite: Suite,
  models: Models | ((log: Logger) => Models),
  options: RunOptions,
): Promise<Result[]> {
  if (suite.requiresAuth && !options.storageState)
    throw new Error(
      'This suite requires an approved Playwright storage-state path',
    );
  const journeys = suite.journeys.filter(
    (journey) => !options.journey || journey.id === options.journey,
  );
  const viewports = suite.viewports.filter(
    (viewport) => !options.viewport || viewport.name === options.viewport,
  );
  if (!journeys.length || !viewports.length)
    throw new Error('No matching journey or viewport');
  await mkdir(dirname(options.directory), { recursive: true, mode: 0o700 });
  await mkdir(options.directory, { mode: 0o700 });
  const log: Logger = async (event, data) => {
    await appendFile(
      join(options.directory, 'events.jsonl'),
      JSON.stringify({ time: new Date().toISOString(), event, data }) + '\n',
      { mode: 0o600 },
    );
  };
  const engine = typeof models === 'function' ? models(log) : models;
  await writeFile(
    join(options.directory, 'suite.json'),
    JSON.stringify(suite, null, 2),
    { mode: 0o600 },
  );
  const driver =
    options.driver ??
    (await playwrightDriver(suite.browser, options.headless ?? true));
  const results: Result[] = [];
  try {
    for (const journey of journeys) {
      for (const viewport of viewports) {
        const directory = join(
          options.directory,
          `${journey.id}-${viewport.name}`,
        );
        await mkdir(directory, { mode: 0o700 });
        const session = await driver.openSession({
          suite,
          journey,
          viewport,
          directory,
          storageState: options.storageState,
          video: options.video,
          log,
        });
        results.push(
          await runJourney(
            session,
            suite,
            journey,
            viewport.name,
            directory,
            engine,
            log,
          ),
        );
        await writeFile(
          join(options.directory, 'results.json'),
          JSON.stringify(results, null, 2),
          { mode: 0o600 },
        );
        await writeFile(
          join(options.directory, 'report.html'),
          reportHTML(suite.name, results, options.directory),
          { mode: 0o600 },
        );
      }
    }
  } finally {
    await driver.close();
  }
  return results;
}
