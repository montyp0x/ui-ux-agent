// Keyboard focus behaviour of keyboard-only journeys (input: keyboard),
// measured from the journey's own key presses. The web driver records one
// transition per key press (src/drivers/playwright-keyboard.ts): what had
// focus before and after it, whether the newly focused element's computed
// style changed when it received focus, and which modal dialog was open. This
// module parses those records at the driver boundary and turns them into
// audit findings; it never presses a key itself, so evaluating the audit does
// not change the page.
import { z } from 'zod';
import type { Journey } from '../contracts.js';
import type { AuditConfig } from './config.js';
import type { AuditOutput, AuditOutputFinding } from './contract.js';
import type { AuditDefinition } from './registry.js';

const count = z.number().int().nonnegative();

export const focusStateSchema = z
  .object({
    // Page-local identity of the element, stable while the document lives.
    id: count,
    // Role and accessible name as the page exposes them (approximate).
    description: z.string().min(1).max(200),
    // A CSS path for reproduction; shadow roots joined by ' >> '.
    selector: z.string().min(1).max(500),
    // Rendered with a box of at least 2x2 CSS px and not hidden by CSS.
    rendered: z.boolean(),
    // Its box intersects the viewport.
    inViewport: z.boolean(),
    // Whether its computed style (or its ::before/::after or parent) changed
    // when it received focus: changed | unchanged | unknown (it did not exist
    // before the key press). Null for the element that had focus before.
    indicator: z.enum(['changed', 'unchanged', 'unknown']).nullable(),
    // Id of the open modal dialog that contains it, or null.
    modal: count.nullable(),
  })
  .strict();
export type FocusState = z.infer<typeof focusStateSchema>;

export const modalStateSchema = z
  .object({ id: count, description: z.string().min(1).max(200) })
  .strict();
export type ModalState = z.infer<typeof modalStateSchema>;

export const keyTransitionSchema = z
  .object({
    // Order of the key press in the session.
    seq: count,
    // Observation step the key was pressed at; the resulting state is step+1.
    step: z.number().int(),
    url: z.string(),
    // key: one of KEYBOARD_KEYS; press: a configured key on its target;
    // fill: a configured value typed into the focused field.
    action: z.enum(['key', 'press', 'fill']),
    key: z.string().min(1).max(40),
    // Null: nothing (the document body) had focus.
    from: focusStateSchema.nullable(),
    to: focusStateSchema.nullable(),
    // The element that had focus was removed by the key press.
    fromDetached: z.boolean(),
    // The topmost open modal dialog before and after the key press.
    modalBefore: modalStateSchema.nullable(),
    modalAfter: modalStateSchema.nullable(),
    // Indices of journey.keyboard.focusOrder targets that `to` matches.
    focusOrder: z.array(count).max(20),
  })
  .strict();
export type KeyTransition = z.infer<typeof keyTransitionSchema>;

export const KEYBOARD_LIMITATIONS = [
  'Only transitions produced by the journey’s own key presses are evaluated; controls the journey never reached by keyboard were not checked.',
  'A focus indicator is detected as a change in the computed outline, box shadow, border, background, colour, text decoration, opacity, transform or filter of the element, its ::before/::after or its parent when it receives focus; its contrast and size are not measured.',
  'Frames are not followed, and focus obscured by other content (sticky headers, overlays) is not measured.',
] as const;

const WCAG = (path: string) =>
  `https://www.w3.org/WAI/WCAG22/Understanding/${path}.html`;
const APG_DIALOG = 'https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/';

const target = (state: FocusState, reason: string | null = null) => ({
  description: state.description,
  selector: state.selector,
  reason,
});

type Rule = {
  ruleId: string;
  severity: AuditOutputFinding['severity'];
  certainty: AuditOutputFinding['certainty'];
  helpUrl: string;
  tags: string[];
};
const RULES = {
  focusVisible: {
    ruleId: 'focus-visible',
    severity: 'serious',
    certainty: 'violation',
    helpUrl: WCAG('focus-visible'),
    tags: ['wcag2aa', 'wcag247', 'keyboard'],
  },
  focusUnverified: {
    ruleId: 'focus-visible',
    severity: 'moderate',
    certainty: 'needs_review',
    helpUrl: WCAG('focus-visible'),
    tags: ['wcag2aa', 'wcag247', 'keyboard'],
  },
  focusHidden: {
    ruleId: 'focus-not-shown',
    severity: 'serious',
    certainty: 'violation',
    helpUrl: WCAG('focus-not-obscured-minimum'),
    tags: ['wcag22aa', 'wcag2411', 'keyboard'],
  },
  trap: {
    ruleId: 'dialog-focus-trap',
    severity: 'serious',
    certainty: 'violation',
    helpUrl: APG_DIALOG,
    tags: ['wcag2a', 'wcag243', 'keyboard', 'dialog'],
  },
  intoDialog: {
    ruleId: 'dialog-initial-focus',
    severity: 'serious',
    certainty: 'violation',
    helpUrl: APG_DIALOG,
    tags: ['wcag2a', 'wcag243', 'keyboard', 'dialog'],
  },
  escape: {
    ruleId: 'dialog-escape',
    severity: 'moderate',
    certainty: 'violation',
    helpUrl: APG_DIALOG,
    tags: ['keyboard', 'dialog', 'expected'],
  },
  restore: {
    ruleId: 'dialog-focus-restore',
    severity: 'moderate',
    certainty: 'violation',
    helpUrl: APG_DIALOG,
    tags: ['wcag2a', 'wcag243', 'keyboard', 'dialog', 'expected'],
  },
  restoreUnknown: {
    ruleId: 'dialog-focus-restore',
    severity: 'moderate',
    certainty: 'needs_review',
    helpUrl: APG_DIALOG,
    tags: ['keyboard', 'dialog', 'expected'],
  },
  order: {
    ruleId: 'focus-order',
    severity: 'serious',
    certainty: 'violation',
    helpUrl: WCAG('focus-order'),
    tags: ['wcag2a', 'wcag243', 'keyboard', 'expected'],
  },
  lost: {
    ruleId: 'focus-lost',
    severity: 'moderate',
    certainty: 'needs_review',
    helpUrl: WCAG('focus-order'),
    tags: ['wcag2a', 'wcag243', 'keyboard'],
  },
  stuck: {
    ruleId: 'focus-stuck',
    severity: 'serious',
    certainty: 'needs_review',
    helpUrl: WCAG('no-keyboard-trap'),
    tags: ['wcag2a', 'wcag212', 'keyboard'],
  },
} satisfies Record<string, Rule>;

export type KeyboardEvidence = {
  // The screenshot of the observed state at a step, when one was taken.
  screenshotAt(step: number): string | null;
};

const isTab = (transition: KeyTransition) =>
  transition.action === 'key' &&
  (transition.key === 'Tab' || transition.key === 'Shift+Tab');

// Findings for the transitions from index `from` on. Earlier transitions are
// read for context only (the control that opened a dialog, a Tab sequence in
// progress), so each transition is reported by exactly one audit run.
export function keyboardFindings(
  transitions: KeyTransition[],
  journey: Pick<Journey, 'keyboard'>,
  from: number,
  evidence: KeyboardEvidence,
): AuditOutputFinding[] {
  const findings: AuditOutputFinding[] = [];
  // One finding per rule and element: a control without an indicator is
  // reported once however often the journey tabs onto it.
  const reported = new Set<string>();
  const report = (
    index: number,
    rule: Rule,
    description: string,
    state: FocusState | null,
    reason: string | null = null,
    key: string = String(state?.id ?? index),
  ) => {
    if (index < from) return;
    const identity = `${rule.ruleId}:${rule.certainty}:${key}`;
    if (reported.has(identity)) return;
    reported.add(identity);
    const transition = transitions[index]!;
    findings.push({
      ...rule,
      description,
      nodeCount: 1,
      targets: state
        ? [target(state, reason)]
        : [{ description: 'document', selector: null, reason }],
      at: {
        step: transition.step + 1,
        url: transition.url,
        screenshot: evidence.screenshotAt(transition.step + 1),
      },
    });
  };
  // The control that had focus when each modal dialog opened.
  const triggers = new Map<number, FocusState | null>();
  const order = journey.keyboard?.focusOrder ?? [];
  // Highest focusOrder index reached in the current run of Tab presses.
  let reached = -1;
  const dialogs = journey.keyboard?.dialogs;
  for (const [index, transition] of transitions.entries()) {
    const { from: before, to, modalBefore, modalAfter, key } = transition;
    const moved = (before?.id ?? null) !== (to?.id ?? null);
    const opened =
      modalAfter !== null && modalAfter.id !== (modalBefore?.id ?? null);
    const closed =
      modalBefore !== null && modalAfter?.id !== modalBefore.id;
    if (opened && !triggers.has(modalAfter.id))
      triggers.set(modalAfter.id, before);

    if (to && moved) {
      if (!to.rendered || !to.inViewport)
        report(
          index,
          RULES.focusHidden,
          `${key} moved focus to ${to.description}, which is ${to.rendered ? 'outside the viewport' : 'not rendered visibly'}`,
          to,
          to.rendered ? 'outside the viewport' : 'hidden or smaller than 2x2 px',
        );
      else if (to.indicator === 'unchanged')
        report(
          index,
          RULES.focusVisible,
          `${to.description} shows no visible change when ${key} moves focus to it`,
          to,
          'no computed style change on focus',
        );
      else if (to.indicator === 'unknown')
        report(
          index,
          RULES.focusUnverified,
          `${to.description} appeared with the ${key} press, so its focus indicator could not be compared with its unfocused style`,
          to,
          'element did not exist before the key press',
        );
    }

    if (opened && (to?.modal ?? null) !== modalAfter.id)
      report(
        index,
        RULES.intoDialog,
        `${modalAfter.description} opened but focus ${to ? `stayed on ${to.description}` : 'went to the document'}, outside the dialog`,
        to,
        null,
        `dialog-${modalAfter.id}`,
      );
    else if (
      isTab(transition) &&
      modalBefore &&
      modalAfter?.id === modalBefore.id &&
      (to?.modal ?? null) !== modalBefore.id
    )
      report(
        index,
        RULES.trap,
        `${key} moved focus out of the open ${modalBefore.description}${to ? ` to ${to.description}` : ' to the document'}`,
        to,
        null,
        `dialog-${modalBefore.id}`,
      );

    if (
      dialogs?.closeOnEscape &&
      transition.action === 'key' &&
      key === 'Escape' &&
      modalBefore &&
      modalAfter?.id === modalBefore.id
    )
      report(
        index,
        RULES.escape,
        `Escape did not close the open ${modalBefore.description}`,
        to,
        null,
        `dialog-${modalBefore.id}`,
      );

    if (dialogs?.restoreFocus && closed) {
      const trigger = triggers.get(modalBefore.id);
      if (trigger === undefined || trigger === null)
        report(
          index,
          RULES.restoreUnknown,
          `${modalBefore.description} closed, but the control that opened it is unknown (it opened ${trigger === null ? 'while nothing had focus' : 'before the journey’s first key press'})`,
          to,
          null,
          `dialog-${modalBefore.id}`,
        );
      else if (to?.id !== trigger.id)
        report(
          index,
          RULES.restore,
          `Closing ${modalBefore.description} moved focus to ${to ? to.description : 'the document'} instead of back to ${trigger.description}, which opened it`,
          to,
          `expected focus on ${trigger.description}`,
          `dialog-${modalBefore.id}`,
        );
    }

    if (
      transition.fromDetached &&
      !to &&
      !isTab(transition) &&
      transition.action !== 'fill'
    )
      report(
        index,
        RULES.lost,
        `${key} removed ${before?.description ?? 'the focused element'} and focus fell back to the document`,
        before,
      );
    if (isTab(transition) && before && to && !moved && !modalAfter)
      report(
        index,
        RULES.stuck,
        `${key} did not move focus away from ${to.description}`,
        to,
        'focus stayed on the element',
      );

    // Expected Tab order: within a run of Tab presses, listed targets are
    // reached in increasing order. Focus leaving the page, any other key or
    // a navigation ends the run; inside a modal dialog, reaching the first
    // target after the last one is the trap wrapping and starts a new run.
    if (order.length) {
      const previous = transitions[index - 1];
      const sameRun =
        transition.action === 'key' &&
        key === 'Tab' &&
        previous?.action === 'key' &&
        previous.key === 'Tab' &&
        previous.url === transition.url;
      if (!sameRun || !to) reached = -1;
      if (transition.action === 'key' && key === 'Tab' && to)
        for (const position of transition.focusOrder) {
          if (
            position === 0 &&
            reached === order.length - 1 &&
            to.modal !== null
          )
            reached = -1;
          if (position < reached)
            report(
              index,
              RULES.order,
              `Tab reached ${to.description} (expected position ${position + 1} of ${order.length}) after position ${reached + 1}`,
              to,
              `focusOrder[${position}] after focusOrder[${reached}]`,
              `order-${position}-${reached}`,
            );
          reached = Math.max(reached, position);
        }
    }
  }
  return findings;
}

type Config = Extract<AuditConfig, { id: 'keyboard.focus' }>;

// The output for one audit run over transitions[from...].
export function keyboardAuditOutput(
  transitions: KeyTransition[],
  journey: Pick<Journey, 'input' | 'keyboard'>,
  from: number,
  evidence: KeyboardEvidence,
): AuditOutput {
  if (journey.input !== 'keyboard')
    return {
      complete: false,
      detail:
        'keyboard.focus measures keyboard-only journeys (input: keyboard); this journey uses pointer input',
      observations: 0,
      limitations: [...KEYBOARD_LIMITATIONS],
      findings: [],
    };
  // Nothing measured is not clean; a later checkpoint with no new key press
  // after earlier ones is.
  if (!transitions.length)
    return {
      complete: false,
      detail: 'The journey pressed no key, so no focus behaviour was measured',
      observations: 0,
      limitations: [...KEYBOARD_LIMITATIONS],
      findings: [],
    };
  const window = transitions.length - from;
  return {
    complete: true,
    detail: window ? null : 'No key press since the previous checkpoint',
    observations: window,
    limitations: [...KEYBOARD_LIMITATIONS],
    findings: keyboardFindings(transitions, journey, from, evidence),
  };
}

export const keyboardFocusAudit: AuditDefinition<Config> = {
  id: 'keyboard.focus',
  source: 'builtin',
  title: 'Keyboard focus behaviour',
  drivers: ['playwright'],
  unsupported:
    'The macOS driver never synthesizes keyboard input, so keyboard focus behaviour is not measured',
};
