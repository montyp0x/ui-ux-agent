// Computes a run's task-friction summary from its recorded event stream.
// Deterministic and derived only from the events (and the journey's reviewed
// reference paths), so it reconciles exactly with events.jsonl. It counts and
// links; it judges nothing: no score, no gate, and model concerns stay
// hypotheses.
import type { FrictionEvent, FrictionLog } from './events.js';
import {
  FRICTION_NOTE,
  REFERENCE_NOTE,
  type ActionMatcher,
  type Friction,
  type FrictionItem,
  type ReferenceComparison,
  type ReferencePath,
  type RubricEntry,
  type Signal,
  type Waypoint,
} from './contract.js';

const RUBRIC: {
  dimension: RubricEntry['dimension'];
  question: string;
  signals: Signal[];
}[] = [
  {
    dimension: 'discoverability',
    question:
      'Could the next step toward the goal be found from what the interface showed?',
    signals: ['noMatchDecisions', 'recoveries', 'detours', 'backtracks'],
  },
  {
    dimension: 'feedback',
    question: 'Did the interface visibly respond to each action?',
    signals: ['noEffect', 'repeats'],
  },
  {
    dimension: 'clarity',
    question:
      'Were pages and controls distinguishable from look-alikes, and was it clear when the goal was reached?',
    signals: ['detours', 'stalledReplans', 'revisitReplans'],
  },
  {
    dimension: 'recovery',
    question:
      'After a failed action or a wrong turn, did the interface help get back on track?',
    signals: ['failedAttempts', 'backtracks'],
  },
];

type Observed = { url: string; screenshot: string };
type ActionData = Extract<FrictionEvent, { event: 'action_result' }>['data'];

// A page is its URL without the fragment: in-page anchors are not pages.
function pageOf(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
const destination = (action: ActionData['action']): string | null =>
  action.href ?? action.url ?? null;

function matches(matcher: ActionMatcher, action: ActionData['action']) {
  if (matcher.action !== undefined && matcher.action !== action.kind)
    return false;
  if (
    matcher.description !== undefined &&
    !new RegExp(matcher.description).test(action.description)
  )
    return false;
  if (matcher.to !== undefined) {
    const to = destination(action);
    if (to === null || !new RegExp(matcher.to).test(pathOf(to))) return false;
  }
  return true;
}

function waypointLabel(waypoint: Waypoint): string {
  if (waypoint.label) return waypoint.label;
  if (waypoint.kind === 'page') return `page ${waypoint.pattern}`;
  return [
    waypoint.action ?? 'action',
    waypoint.description !== undefined ? `/${waypoint.description}/` : '',
    waypoint.to !== undefined ? `to ${waypoint.to}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

type Moment =
  | { kind: 'page'; path: string; line: number; step: number }
  | { kind: 'action'; action: ActionData['action']; line: number; step: number };

function compare(
  path: ReferencePath,
  moments: Moment[],
  product: ActionData['action'][],
): ReferenceComparison {
  const hit = (waypoint: Waypoint, moment: Moment) =>
    waypoint.kind === 'page'
      ? moment.kind === 'page' && new RegExp(waypoint.pattern).test(moment.path)
      : moment.kind === 'action' && matches(waypoint, moment.action);
  const consumed = new Set<number>();
  let cursor = -1;
  const waypoints = path.waypoints.map((waypoint, index) => {
    // Ordered: the first match after the previous matched waypoint (an
    // unmatched waypoint does not block later ones). Unordered: the first
    // match anywhere; an action is used by one waypoint only.
    const found = moments.findIndex(
      (moment, at) =>
        (path.ordered ? at > cursor : !consumed.has(at)) && hit(waypoint, moment),
    );
    if (found >= 0) {
      if (path.ordered) cursor = found;
      else if (moments[found]!.kind === 'action') consumed.add(found);
    }
    const moment = found >= 0 ? moments[found]! : null;
    return {
      index,
      label: waypointLabel(waypoint),
      matched: !!moment,
      line: moment?.line ?? null,
      step: moment?.step ?? null,
    };
  });
  const matched = waypoints.filter((waypoint) => waypoint.matched).length;
  const allowedActions = product.filter((action) =>
    path.allow.some((matcher) => matches(matcher, action)),
  ).length;
  const comparedActions = product.length - allowedActions;
  const expectedActions =
    path.expectedActions ??
    path.waypoints.filter((waypoint) => waypoint.kind === 'action').length;
  return {
    name: path.name,
    ordered: path.ordered,
    followed: matched === waypoints.length,
    matched,
    total: waypoints.length,
    waypoints,
    expectedActions,
    comparedActions,
    allowedActions,
    extraActions: Math.max(0, comparedActions - expectedActions),
  };
}

export function computeFriction(
  log: FrictionLog,
  journey: { referencePaths?: ReferencePath[] | undefined },
): Friction {
  const { events } = log;
  // The observed state of each step (the latest observation of that step).
  const observed = new Map<number, Observed>();
  for (const entry of events)
    if (entry.event === 'observation' || entry.event === 'content_observation')
      observed.set(entry.data.step, entry.data);
  const shot = (step: number) => observed.get(step)?.screenshot ?? null;
  const link = (line: number, step: number) => ({
    line,
    step,
    url: observed.get(step)?.url ?? null,
    before: shot(step),
    after: shot(step + 1),
  });

  const items: FrictionItem[] = [];
  const actions = { executed: 0, product: 0, waits: 0, recovery: 0 };
  const overhead: Friction['overhead'] = {
    plannerRefreshes: 0,
    refreshReasons: {},
    noMatchDecisions: 0,
    revisitReplans: 0,
    recoveryActions: 0,
  };
  const hypotheses: Friction['hypotheses'] = [];
  const noMatchSteps = new Set<number>();
  // Pages observed so far, with the step each was first observed at.
  const seen = new Map<string, number>();
  const moments: Moment[] = [];
  const product: ActionData['action'][] = [];

  for (const entry of events) {
    switch (entry.event) {
      case 'observation':
      case 'content_observation': {
        const page = pageOf(entry.data.url);
        if (!seen.has(page)) seen.set(page, entry.data.step);
        moments.push({
          kind: 'page',
          path: pathOf(entry.data.url),
          line: entry.line,
          step: entry.data.step,
        });
        break;
      }
      case 'plan': {
        overhead.plannerRefreshes++;
        for (const reason of entry.data.refreshReasons)
          overhead.refreshReasons[reason] =
            (overhead.refreshReasons[reason] ?? 0) + 1;
        if (entry.data.plan.concerns.length)
          hypotheses.push({
            line: entry.line,
            step: entry.data.step,
            concerns: entry.data.plan.concerns.length,
          });
        break;
      }
      case 'decision':
        if (entry.data.decision.choice === 'no_match') {
          overhead.noMatchDecisions++;
          noMatchSteps.add(entry.data.step);
        }
        break;
      case 'loop_check': {
        const { step, visits, outcome, action } = entry.data;
        if (outcome === 'replan') overhead.revisitReplans++;
        else if (visits >= 2)
          items.push({
            kind: 'repeat',
            // A recovery action is chosen by the runner after no_match.
            actor: noMatchSteps.has(step) ? 'overhead' : 'product',
            description: action,
            detail: `visit ${visits} of this action in this state (${outcome})`,
            ...link(entry.line, step),
          });
        break;
      }
      case 'action_result': {
        const { step, action, source, changed, error } = entry.data;
        const actor = source === 'recovery' ? 'overhead' : 'product';
        actions.executed++;
        if (source === 'recovery') {
          actions.recovery++;
          overhead.recoveryActions++;
        } else if (action.kind === 'wait') actions.waits++;
        else {
          actions.product++;
          product.push(action);
        }
        if (source === 'selector' && !error)
          moments.push({ kind: 'action', action, line: entry.line, step });
        const base = {
          actor,
          description: action.description,
          ...link(entry.line, step),
        } as const;
        if (error) {
          items.push({
            kind: 'failed_attempt',
            ...base,
            detail: `${error.startsWith('Stale observation') ? 'stale' : 'error'}: ${error}`,
          });
          break;
        }
        const before = observed.get(step);
        const after = observed.get(step + 1);
        if (action.kind === 'back')
          items.push({
            kind: 'backtrack',
            ...base,
            detail: `browser history back to ${action.url ?? 'the previous entry'}`,
          });
        else if (
          before &&
          after &&
          pageOf(after.url) !== pageOf(before.url) &&
          seen.has(pageOf(after.url))
        )
          items.push({
            kind: 'backtrack',
            ...base,
            detail: `returned to ${pageOf(after.url)}, observed earlier at step ${seen.get(pageOf(after.url))}`,
          });
        if (!changed && action.kind !== 'wait')
          items.push({
            kind: 'no_effect',
            ...base,
            detail: 'the observed state did not change',
          });
        break;
      }
      case 'detour':
        items.push({
          kind: 'detour',
          actor: 'product',
          description: `Reached ${entry.data.path}: ${entry.data.description}`,
          detail: `observed step ${entry.data.visits} on this detour`,
          ...link(entry.line, entry.data.step),
        });
        break;
      case 'recovery':
        items.push({
          kind: 'recovery',
          actor: 'overhead',
          description: entry.data.reason,
          detail: `runner recovery attempt ${entry.data.attempt} of ${entry.data.limit}`,
          ...link(entry.line, entry.data.step),
        });
        break;
    }
  }

  const total = (kind: FrictionItem['kind']) =>
    items.filter((item) => item.kind === kind).length;
  const counts: Friction['counts'] = {
    backtracks: total('backtrack'),
    repeats: total('repeat'),
    recoveries: total('recovery'),
    detours: total('detour'),
    failedAttempts: total('failed_attempt'),
    noEffect: total('no_effect'),
  };
  const signal: Record<Signal, number> = {
    ...counts,
    noMatchDecisions: overhead.noMatchDecisions,
    revisitReplans: overhead.revisitReplans,
    stalledReplans: overhead.refreshReasons['stalled'] ?? 0,
  };
  const rubric: RubricEntry[] = RUBRIC.map((entry) => {
    const signals = entry.signals.map((name) => ({
      signal: name,
      count: signal[name],
    }));
    return {
      dimension: entry.dimension,
      question: entry.question,
      signals,
      status: signals.some((item) => item.count > 0)
        ? 'signals_observed'
        : 'no_signals',
      review: 'pending',
    };
  });

  let reference: Friction['reference'] = null;
  if (journey.referencePaths?.length) {
    const paths = journey.referencePaths.map((path) =>
      compare(path, moments, product),
    );
    // Closest: the largest share of matched waypoints, then the fewest extra
    // actions, then configuration order.
    const closest = paths.reduce((best, path) =>
      path.matched / path.total > best.matched / best.total ||
      (path.matched / path.total === best.matched / best.total &&
        path.extraActions < best.extraActions)
        ? path
        : best,
    );
    reference = { note: REFERENCE_NOTE, closest: closest.name, paths };
  }

  return {
    version: 1,
    basis: 'agent_run',
    note: FRICTION_NOTE,
    events: {
      first: events[0]?.line ?? null,
      last: events.at(-1)?.line ?? null,
      considered: events.length,
      unparsed: log.unparsed,
    },
    actions,
    overhead,
    counts,
    items: items.sort((a, b) => a.line - b.line),
    rubric,
    hypotheses,
    reference,
  };
}
