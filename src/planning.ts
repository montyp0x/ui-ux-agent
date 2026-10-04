import type { Action } from './contracts.js';
import type { History } from './models.js';

// Candidate IDs and wheel hit points are transient bindings, not new planning opportunities.
export function actionSignature(actions: Action[]): string {
  return JSON.stringify(
    actions
      .map((action) => {
        const { id: _id, ...meaning } = action;
        if (meaning.kind === 'scroll') {
          const { point: _point, ...regionAction } = meaning;
          return JSON.stringify(regionAction);
        }
        return JSON.stringify(meaning);
      })
      .sort(),
  );
}

export type PlanState = { url: string; actions: string; step: number };
export type RefreshReason =
  | 'initial'
  | 'selector-no-match'
  | 'navigation'
  | 'available-actions'
  | 'periodic'
  | 'action-error'
  | 'no-progress';

export function refreshReasons(
  hasPlan: boolean,
  previous: PlanState | null,
  current: PlanState,
  history: History,
): RefreshReason[] {
  if (!hasPlan || !previous)
    return [previous ? 'selector-no-match' : 'initial'];
  const reasons: RefreshReason[] = [];
  if (current.url !== previous.url) reasons.push('navigation');
  if (current.actions !== previous.actions) reasons.push('available-actions');
  if (current.step - previous.step >= 5) reasons.push('periodic');
  if (history.at(-1)?.error) reasons.push('action-error');
  if (history.at(-1)?.changed === false) reasons.push('no-progress');
  return reasons;
}
