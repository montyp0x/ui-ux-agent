// Keyboard-only journeys (input: keyboard) on the web driver. Every action is
// a key pressed on whatever has focus, through Playwright's page keyboard (the
// browser's own key events): no element is clicked, focused programmatically
// or scrolled with the wheel, and execute refuses any other action kind, so a
// keyboard journey cannot fall back to the pointer. Each key press is
// recorded as a focus transition for the keyboard.focus audit
// (src/audits/keyboard.ts). Only the fixed engine code below runs in the page.
import type { ElementHandle, JSHandle, Page } from 'playwright';
import {
  keyTransitionSchema,
  keyboardAuditOutput,
  type FocusState,
  type KeyTransition,
  type ModalState,
} from '../audits/keyboard.js';
import type { AuditOutput } from '../audits/contract.js';
import {
  KEYBOARD_KEYS,
  fillValue,
  webBlocked,
  type Action,
  type Journey,
  type Observation,
} from '../contracts.js';
import { AUTH_LINK_NAME, allowedURL, locate } from '../browser.js';

type Element = ElementHandle<HTMLElement | SVGElement>;
type Guard = {
  url: string;
  // The deeply focused element when the action was offered (null: body).
  focused: Element | null;
  modal: number | null;
};
// Symbol.for keys of the engine's page-side state: element ids and the
// pre-key style snapshot. Symbol-keyed, so page scripts do not see them by
// accident.
const IDS_KEY = 'ui-ux-agent.keyboard.ids';
const STYLES_KEY = 'ui-ux-agent.keyboard.styles';
// After a key press, how long focus must stay on one element, with no
// animation running, before the result is measured, and the most to wait
// for that. A fixed pause is not enough: a dialog closing with an exit
// animation hands focus back only once it is removed, so a measurement in
// between sees focus on a control that is about to vanish, and the next key
// is refused as stale when focus then moves.
const SETTLE_MS = 120;
const SETTLE_MAX_MS = 2000;
const SETTLE_KEY = 'ui-ux-agent.keyboard.settle';

// Waits until the page has settled after a key press (see SETTLE_MS). A page
// that keeps moving focus or animating past SETTLE_MAX_MS, or that navigates
// meanwhile, is measured as it is.
async function settle(page: Page): Promise<void> {
  const token = `${Date.now()}-${Math.random()}`;
  await page
    .waitForFunction(
      ({ key, token, quiet }) => {
        const store = window as unknown as Record<
          symbol,
          { token: string; active: globalThis.Element | null; since: number } | undefined
        >;
        const slot = Symbol.for(key);
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement)
          active = active.shadowRoot.activeElement;
        // Finite animations only: a spinner runs forever.
        const animating = document
          .getAnimations()
          .some(
            (animation) =>
              animation.playState === 'running' &&
              animation.effect?.getComputedTiming().iterations !== Infinity,
          );
        const now = performance.now();
        const state = store[slot];
        if (!state || state.token !== token || state.active !== active || animating) {
          store[slot] = { token, active, since: now };
          return false;
        }
        return now - state.since >= quiet;
      },
      { key: SETTLE_KEY, token, quiet: SETTLE_MS },
      { polling: 40, timeout: SETTLE_MAX_MS },
    )
    .catch(() => undefined);
}

const guards = new WeakMap<Action, Guard>();
const offered = new WeakMap<Page, { actions: Action[]; focused: Element | null }>();
const transitions = new WeakMap<Page, KeyTransition[]>();
// Transitions already evaluated by keyboard.focus audit runs.
const audited = new WeakMap<Page, number>();

export const isKeyboardAction = (action: Action): boolean =>
  ['key', 'fill', 'press', 'wait'].includes(action.kind);

export function keyboardTransitions(page: Page): KeyTransition[] {
  return transitions.get(page) ?? [];
}

async function release(page: Page): Promise<void> {
  const previous = offered.get(page);
  offered.delete(page);
  for (const action of previous?.actions ?? []) guards.delete(action);
  await previous?.focused?.dispose().catch(() => undefined);
}

// The element that has keyboard focus, following open shadow roots; null
// when nothing (the body) has focus.
async function focusedElement(page: Page): Promise<Element | null> {
  const handle: JSHandle = await page.evaluateHandle(() => {
    let active: globalThis.Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement)
      active = active.shadowRoot.activeElement;
    return active === document.body || active === document.documentElement
      ? null
      : active;
  });
  const element = handle.asElement() as Element | null;
  if (!element) await handle.dispose();
  return element;
}

async function sameFocus(page: Page, before: Element | null): Promise<boolean> {
  const now = await focusedElement(page);
  try {
    if (!now || !before) return now === before;
    return await now.evaluate((element, old) => element === old, before);
  } finally {
    await now?.dispose();
  }
}

type PageFocus = {
  focus: FocusState | null;
  modal: ModalState | null;
  fromDetached: boolean;
};

// Runs in the page. phase before: records the visual style of every
// focusable element (and the focused element) and describes the current
// focus. phase after: describes the new focus, comparing its style with the
// recorded one, then drops the record.
function measureFocus({
  phase,
  idsKey,
  stylesKey,
}: {
  phase: 'before' | 'after' | 'peek';
  idsKey: string;
  stylesKey: string;
}): PageFocus {
  type Store = { next: number; ids: WeakMap<object, number> };
  type Styles = { styles: WeakMap<object, string>; from: globalThis.Element | null };
  const registry = window as unknown as Record<symbol, unknown>;
  const idsSymbol = Symbol.for(idsKey);
  const stylesSymbol = Symbol.for(stylesKey);
  const store = (registry[idsSymbol] ??= {
    next: 1,
    ids: new WeakMap(),
  }) as Store;
  const PROPS = [
    'outline-style',
    'outline-width',
    'outline-color',
    'outline-offset',
    'box-shadow',
    'border-top-style',
    'border-top-width',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-bottom-width',
    'border-left-color',
    'background-color',
    'background-image',
    'color',
    'text-decoration-line',
    'text-decoration-color',
    'text-shadow',
    'opacity',
    'transform',
    'filter',
  ];
  const PARENT_PROPS = [
    'outline-style',
    'outline-width',
    'outline-color',
    'box-shadow',
    'background-color',
    'border-top-color',
  ];
  // Helpers are methods, not named functions: the function is serialized
  // into the page, and named functions would carry the bundler's __name.
  const tools = {
    idOf(element: object): number {
      let id = store.ids.get(element);
      if (id === undefined) store.ids.set(element, (id = store.next++));
      return id;
    },
    signature(element: globalThis.Element): string {
      const parts: string[] = [];
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        parts.push(PROPS.map((name) => style.getPropertyValue(name)).join('|'));
      }
      const parent = element.parentElement;
      if (parent) {
        const style = getComputedStyle(parent);
        parts.push(
          PARENT_PROPS.map((name) => style.getPropertyValue(name)).join('|'),
        );
      }
      return parts.join('#');
    },
    active(): globalThis.Element | null {
      let element: globalThis.Element | null = document.activeElement;
      while (element?.shadowRoot?.activeElement)
        element = element.shadowRoot.activeElement;
      return element === document.body || element === document.documentElement
        ? null
        : element;
    },
    text(value: string | null | undefined): string {
      return (value ?? '').replace(/\s+/g, ' ').trim();
    },
    role(element: globalThis.Element): string {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit.split(/\s+/)[0]!;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'dialog') return 'dialog';
      if (tag === 'input') {
        const type = (element as HTMLInputElement).type;
        const roles: Record<string, string> = {
          checkbox: 'checkbox',
          radio: 'radio',
          button: 'button',
          submit: 'button',
          reset: 'button',
          range: 'slider',
          search: 'searchbox',
        };
        return roles[type] ?? 'textbox';
      }
      return tag;
    },
    name(element: globalThis.Element): string {
      const label = tools.text(element.getAttribute('aria-label'));
      if (label) return label;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const root = element.getRootNode() as Document | ShadowRoot;
        const joined = tools.text(
          labelledBy
            .split(/\s+/)
            .map((id) => root.getElementById?.(id)?.textContent ?? '')
            .join(' '),
        );
        if (joined) return joined;
      }
      const labels = (element as HTMLInputElement).labels;
      if (labels?.length) return tools.text(labels[0]!.textContent);
      if (
        element instanceof HTMLElement &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
      ) {
        const own = tools.text(element.innerText);
        if (own) return own.slice(0, 80);
      }
      return tools
        .text(
          element.getAttribute('title') ??
            element.getAttribute('placeholder') ??
            (element as HTMLInputElement).value,
        )
        .slice(0, 80);
    },
    describe(element: globalThis.Element): string {
      return `${tools.role(element)} "${tools.name(element)}"`.slice(0, 200);
    },
    selector(element: globalThis.Element): string {
      const parts: string[] = [];
      let node: globalThis.Element | null = element;
      while (node && parts.length < 6) {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
          parts.unshift(`#${node.id}`);
          break;
        }
        const tag = node.tagName.toLowerCase();
        const parent: globalThis.Element | null = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const current: globalThis.Element = node;
        const same = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName,
        );
        parts.unshift(
          same.length > 1
            ? `${tag}:nth-of-type(${same.indexOf(current) + 1})`
            : tag,
        );
        node = parent;
      }
      const root = element.getRootNode();
      const own = parts.join(' > ') || element.tagName.toLowerCase();
      return (
        root instanceof ShadowRoot
          ? `${tools.selector(root.host)} >> ${own}`
          : own
      ).slice(0, 500);
    },
    isModal(element: globalThis.Element): boolean {
      if (element.tagName === 'DIALOG') {
        try {
          return element.matches(':modal');
        } catch {
          return false;
        }
      }
      return (
        element.getAttribute('aria-modal') === 'true' &&
        (element.checkVisibility?.({ checkVisibilityCSS: true }) ??
          (element as HTMLElement).offsetParent !== null)
      );
    },
    contains(container: globalThis.Element, element: globalThis.Element) {
      let node: Node | null = element;
      while (node) {
        if (node === container) return true;
        node =
          node.parentNode instanceof ShadowRoot
            ? node.parentNode.host
            : node.parentNode;
      }
      return false;
    },
    focusables(): globalThis.Element[] {
      const out: globalThis.Element[] = [];
      const roots: ParentNode[] = [document];
      for (let index = 0; index < roots.length && out.length < 2000; index++)
        for (const element of Array.from(roots[index]!.querySelectorAll('*'))) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
          if (
            element.matches(
              'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]:not([contenteditable="false"])',
            )
          )
            out.push(element);
        }
      return out;
    },
  };
  const modals = Array.from(
    document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]'),
  ).filter((element) => tools.isModal(element));
  const topModal = modals.at(-1) ?? null;
  const focused = tools.active();
  let indicator: FocusState['indicator'] = null;
  let fromDetached = false;
  if (phase === 'before') {
    const styles = new WeakMap<object, string>();
    for (const element of tools.focusables())
      styles.set(element, tools.signature(element));
    if (focused) styles.set(focused, tools.signature(focused));
    registry[stylesSymbol] = { styles, from: focused } satisfies Styles;
  } else if (phase === 'after') {
    const recorded = registry[stylesSymbol] as Styles | undefined;
    delete registry[stylesSymbol];
    fromDetached = !!recorded?.from && !recorded.from.isConnected;
    if (focused) {
      const before = recorded?.styles.get(focused);
      indicator =
        before === undefined
          ? 'unknown'
          : before === tools.signature(focused)
            ? 'unchanged'
            : 'changed';
    }
  }
  let focus: FocusState | null = null;
  if (focused) {
    const box = focused.getBoundingClientRect();
    const visible =
      focused.checkVisibility?.({
        checkOpacity: true,
        checkVisibilityCSS: true,
      }) ?? true;
    focus = {
      id: tools.idOf(focused),
      description: tools.describe(focused),
      selector: tools.selector(focused),
      rendered: visible && box.width >= 2 && box.height >= 2,
      inViewport:
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < window.innerHeight &&
        box.left < window.innerWidth,
      indicator,
      modal: (() => {
        const container = modals
          .slice()
          .reverse()
          .find((modal) => tools.contains(modal, focused));
        return container ? tools.idOf(container) : null;
      })(),
    };
  }
  return {
    focus,
    modal: topModal
      ? { id: tools.idOf(topModal), description: tools.describe(topModal) }
      : null,
    fromDetached,
  };
}

async function measure(
  page: Page,
  phase: 'before' | 'after' | 'peek',
): Promise<PageFocus> {
  return page.evaluate(measureFocus, {
    phase,
    idsKey: IDS_KEY,
    stylesKey: STYLES_KEY,
  });
}

// The focused element and open modal, folded into a keyboard journey's
// observation fingerprint: moving focus is a state change there.
export async function focusKey(page: Page): Promise<string> {
  const { focus, modal } = await measure(page, 'peek');
  return JSON.stringify([focus?.id ?? null, focus?.description ?? null, modal?.id ?? null]);
}

// The keyboard actions offered at the current state: every key in
// The keys that would activate the focused element where a pointer journey
// would never be offered it: Enter on a link that leaves the journey's scope
// (a sign-in or sign-out link included, whatever its route), and Enter and
// Space on a control whose name is blocked (WEB_BLOCKED_CONTROLS). Scope is
// otherwise checked after a key navigated, which is too late for signing
// out. A configured interaction on the element keeps its keys.
async function activationWithheld(
  page: Page,
  focused: Element,
  journey: Journey,
  baseURL: string,
  origins: string[],
  blockedControls: readonly string[],
): Promise<(typeof KEYBOARD_KEYS)[number][]> {
  const read = await focused
    .evaluate((element) => {
      const raw = element.getAttribute('href');
      let href: string | null = null;
      try {
        if (raw !== null) href = new URL(raw, element.baseURI).href;
      } catch {
        // An unparseable href leads nowhere.
      }
      // An <input type="submit"> is named by its value; a <button>, whose
      // type is also "submit", by its text.
      const value =
        element instanceof HTMLInputElement &&
        ['submit', 'button', 'reset'].includes(element.type)
          ? element.value
          : '';
      const name =
        (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
          .join(' ')
          .trim() ||
        element.getAttribute('aria-label') ||
        value ||
        element.textContent ||
        '';
      return {
        link: element.matches('a, area, [role="link"]') && href !== null,
        href,
        name: name.replace(/\s+/g, ' ').trim(),
      };
    })
    .catch(() => null);
  if (!read) return [];
  const withheld: (typeof KEYBOARD_KEYS)[number][] =
    read.link &&
    (!allowedURL(read.href!, baseURL, journey.allowedPaths, origins) ||
      AUTH_LINK_NAME.test(read.name))
      ? ['Enter']
      : !read.link && webBlocked(read.name, blockedControls)
        ? ['Enter', 'Space']
        : [];
  if (!withheld.length) return [];
  for (const interaction of journey.interactions) {
    const target = locate(page, interaction.target);
    if (
      (await target.count()) === 1 &&
      (await target.evaluate((element, current) => element === current, focused))
    )
      return [];
  }
  return withheld;
}

// KEYBOARD_KEYS, a configured fill or press whose target has focus, and wait.
// Nothing that needs the pointer: no links, clicks, scrolling or history.
export async function keyboardCandidates(
  page: Page,
  journey: Journey,
  baseURL = page.url(),
  origins: string[] = [],
  // The suite's own blockedControls, added to WEB_BLOCKED_CONTROLS.
  blockedControls: readonly string[] = [],
): Promise<Action[]> {
  await release(page);
  const url = page.url();
  const focused = await focusedElement(page);
  const { focus, modal } = await measure(page, 'peek');
  const where = focus ? `focus on ${focus.description}` : 'nothing focused';
  const withheld = focused
    ? await activationWithheld(
        page,
        focused,
        journey,
        baseURL,
        origins,
        blockedControls,
      )
    : [];
  const out: Action[] = KEYBOARD_KEYS.filter(
    (key) => !withheld.includes(key),
  ).map((key) => ({
    kind: 'key' as const,
    id: '',
    key,
    description: `Press ${key} (${where})`,
  }));
  for (const interaction of journey.interactions) {
    if (interaction.kind !== 'fill' && interaction.kind !== 'press') continue;
    const target = locate(page, interaction.target);
    if (!focused || (await target.count()) !== 1) continue;
    const hasFocus = await target.evaluate(
      (element, current) => element === current,
      focused,
    );
    if (hasFocus && (await target.isEnabled()))
      out.push({ ...interaction, id: '' });
  }
  out.push({ kind: 'wait', id: '', description: 'Wait briefly for loading to finish' });
  out.forEach((action, index) => {
    action.id = `a${index}`;
    guards.set(action, { url, focused, modal: modal?.id ?? null });
  });
  offered.set(page, { actions: out, focused });
  return out;
}

export async function keyboardRepeatState(
  page: Page,
  action: Action,
): Promise<string | null> {
  const guard = guards.get(action);
  if (!guard || action.kind === 'wait') return null;
  const { focus, modal } = await measure(page, 'peek');
  return JSON.stringify({
    url: guard.url,
    focus: focus ? [focus.id, focus.description] : null,
    modal: modal?.id ?? null,
    action: action.kind === 'key' ? action.key : action.description,
  });
}

const PLAYWRIGHT_KEY: Record<(typeof KEYBOARD_KEYS)[number], string> = {
  Tab: 'Tab',
  'Shift+Tab': 'Shift+Tab',
  Enter: 'Enter',
  Space: 'Space',
  Escape: 'Escape',
  ArrowDown: 'ArrowDown',
  ArrowUp: 'ArrowUp',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
};

export async function keyboardExecute(
  page: Page,
  action: Action,
  before: Observation,
  journey: Journey,
  baseURL: string,
  origins: string[] = [],
): Promise<void> {
  if (!isKeyboardAction(action))
    throw new Error(
      `Keyboard-only journey refused a ${action.kind} action: it would need pointer input`,
    );
  const guard = guards.get(action);
  if (!guard)
    throw new Error(
      'Stale observation: action was not captured by this browser',
    );
  if (page.url() !== before.url || page.url() !== guard.url)
    throw new Error('Stale observation: navigation changed during selection');
  if (action.kind === 'wait') {
    await page.waitForTimeout(500);
    return;
  }
  if (!(await sameFocus(page, guard.focused)))
    throw new Error('Stale observation: keyboard focus changed during selection');
  const start = await measure(page, 'before');
  if ((start.modal?.id ?? null) !== guard.modal)
    throw new Error('Stale observation: dialog context changed during selection');
  let key: string;
  if (action.kind === 'key') {
    key = action.key;
    await page.keyboard.press(PLAYWRIGHT_KEY[action.key]);
  } else if (action.kind === 'press') {
    key = action.key;
    await page.keyboard.press(action.key);
  } else if (action.kind === 'fill') {
    // Replace the focused field's value by typing, as a keyboard user does.
    key = 'type';
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    const value = fillValue(action);
    if (value) await page.keyboard.type(value);
  } else throw new Error(`Unexpected keyboard action ${action.kind}`);
  await settle(page);
  const url = page.url();
  // A key press that navigated measures the new document's focus.
  const end = await measure(page, 'after').catch(() => null);
  const order = journey.keyboard?.focusOrder ?? [];
  const reached: number[] = [];
  if (end?.focus && order.length) {
    const focused = await focusedElement(page);
    try {
      for (const [index, target] of order.entries()) {
        const located = locate(page, target);
        if (
          focused &&
          (await located.count()) === 1 &&
          (await located.evaluate(
            (element, current) => element === current,
            focused,
          ))
        )
          reached.push(index);
      }
    } finally {
      await focused?.dispose();
    }
  }
  const log = transitions.get(page) ?? [];
  transitions.set(page, log);
  log.push(
    keyTransitionSchema.parse({
      seq: log.length,
      step: before.step,
      url: before.url,
      action: action.kind,
      key,
      from: start.focus,
      to: end?.focus ?? null,
      fromDetached: end?.fromDetached ?? false,
      modalBefore: start.modal,
      modalAfter: end?.modal ?? null,
      focusOrder: reached,
    }),
  );
  if (url !== before.url && !allowedURL(url, baseURL, journey.allowedPaths, origins))
    throw new Error('Navigation left the journey scope');
}

// The keyboard.focus audit over the key presses since its previous run.
export function keyboardFocusPlaywrightAudit(
  page: Page,
  journey: Journey,
  screenshotAt: (step: number) => string | null,
): AuditOutput {
  const all = keyboardTransitions(page);
  const from = audited.get(page) ?? 0;
  audited.set(page, all.length);
  return keyboardAuditOutput(all, journey, from, { screenshotAt });
}
