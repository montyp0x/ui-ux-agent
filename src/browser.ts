import { createHash } from 'node:crypto';
import {
  errors,
  type CDPSession,
  type ElementHandle,
  type Locator,
  type Page,
  type Request,
} from 'playwright';
import type {
  Action,
  Check,
  Journey,
  Observation,
  ScrollPoint,
  Suite,
  Target,
} from './contracts.js';
import { projectViewport } from './viewport.js';
import { scrollGeometry } from './scroll.js';
import type { EventLogger } from './drivers/types.js';

type Element = ElementHandle<HTMLElement | SVGElement>;
type Guard =
  | { kind: 'wait'; url: string }
  | { kind: 'back'; url: string; target: string; index: number }
  | {
      kind: 'control';
      url: string;
      element: Element;
      state: string;
      dialogs: Element[];
    }
  | {
      kind: 'scroll';
      url: string;
      element: Element;
      x: number;
      y: number;
      width: number;
      height: number;
      dialogs: Element[];
      point: ScrollPoint;
      direction: 'up' | 'down';
    };
// Evidence that an offered candidate changed while its guard was being bound.
type Skip = {
  reason: 'detached' | 'ambiguous' | 'replaced' | 'no_recipient';
  matches?: number;
  detail?: string;
};
// Discovery has just seen the candidate, so capture only bridges a short race;
// it must not wait out the task timeout for an element that has gone.
const CAPTURE_TIMEOUT_MS = 1000;
const guards = new WeakMap<Action, Guard>();
const offeredActions = new WeakMap<
  Page,
  { actions: Action[]; dialogs: Element[] }
>();

async function releaseActions(page: Page): Promise<void> {
  const offered = offeredActions.get(page);
  const elements = new Set<Element>(offered?.dialogs);
  for (const action of offered?.actions ?? []) {
    const guard = guards.get(action);
    if (guard && 'element' in guard) {
      elements.add(guard.element);
      guard.dialogs.forEach((element) => elements.add(element));
    }
    guards.delete(action);
  }
  offeredActions.delete(page);
  await Promise.allSettled([...elements].map((element) => element.dispose()));
}

// The browser's own session history (including same-document entries). Only
// Chromium exposes it, through CDP; other engines are offered no back action.
const historySessions = new WeakMap<Page, Promise<CDPSession | null>>();
async function navigationHistory(
  page: Page,
): Promise<{ index: number; previous: string | null } | null> {
  if (!historySessions.has(page))
    historySessions.set(
      page,
      page.context().browser()?.browserType().name() === 'chromium'
        ? page.context().newCDPSession(page)
        : Promise.resolve(null),
    );
  const session = await historySessions.get(page)!;
  if (!session) return null;
  const { currentIndex, entries } = await session.send(
    'Page.getNavigationHistory',
  );
  return {
    index: currentIndex,
    previous: currentIndex > 0 ? entries[currentIndex - 1]!.url : null,
  };
}

async function dialogs(page: Page): Promise<Element[]> {
  const visible: Element[] = [];
  for (const dialog of await page.getByRole('dialog').all()) {
    if (await dialog.isVisible()) {
      const element = await dialog.elementHandle();
      if (element) visible.push(element);
    }
  }
  return visible;
}

async function sameDialogs(page: Page, before: Element[]): Promise<boolean> {
  const current = await dialogs(page);
  try {
    if (current.length !== before.length) return false;
    for (let index = 0; index < current.length; index++) {
      if (
        !(await current[index]!.evaluate(
          (element, old) => element === old,
          before[index]!,
        ))
      )
        return false;
    }
    return true;
  } finally {
    await Promise.all(current.map((element) => element.dispose()));
  }
}

async function controlState(
  target: Locator,
  timeout?: number,
): Promise<string> {
  return JSON.stringify({
    snapshot: await target.ariaSnapshot({ timeout }),
    properties: await target.evaluate(
      (element) => {
        const control = element as HTMLInputElement;
        const form = control.form;
        return {
          tag: element.tagName,
          attributes: [
            'href',
            'target',
            'type',
            'name',
            'role',
            'formaction',
            'formmethod',
            'readonly',
            'aria-disabled',
          ].map((name) => [name, element.getAttribute(name)]),
          value: control.value,
          checked: control.checked,
          disabled: control.disabled,
          formAction: control.formAction,
          formMethod: control.formMethod,
          formTarget: control.formTarget,
          resolvedHref:
            element instanceof HTMLAnchorElement ? element.href : null,
          form: form
            ? { action: form.action, method: form.method, target: form.target }
            : null,
          options:
            element instanceof HTMLSelectElement
              ? Array.from(element.options, (option) => ({
                  value: option.value,
                  text: option.text,
                  disabled: option.disabled,
                }))
              : null,
        };
      },
      undefined,
      { timeout },
    ),
  });
}

function firstLine(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.split('\n')[0]!.slice(0, 200);
}

// Binds the control's identity and state, or proves it changed meanwhile.
// Failures on a control that is still present and unchanged propagate.
async function bindControl(
  target: Locator,
  bound: (element: Element, state: string) => void,
): Promise<Skip | null> {
  const present = await target.count();
  if (present !== 1)
    return { reason: present ? 'ambiguous' : 'detached', matches: present };
  let element: Element | null = null;
  let failure: unknown = null;
  try {
    element = (await target.elementHandle({
      timeout: CAPTURE_TIMEOUT_MS,
    })) as Element | null;
    if (element) {
      const state = await controlState(target, CAPTURE_TIMEOUT_MS);
      if (
        await target.evaluate((current, old) => current === old, element, {
          timeout: CAPTURE_TIMEOUT_MS,
        })
      ) {
        bound(element, state);
        return null;
      }
    }
  } catch (caught) {
    failure = caught;
  }
  try {
    const matches = await target.count();
    const detail = failure ? firstLine(failure) : undefined;
    if (!element) {
      // Absent for the whole capture window: the candidate is gone, not slow.
      if (!failure || failure instanceof errors.TimeoutError)
        return { reason: 'detached', matches, detail };
    } else if (matches === 0) return { reason: 'detached', matches, detail };
    else if (matches > 1) return { reason: 'ambiguous', matches, detail };
    else if (
      !failure ||
      !(await target.evaluate((current, old) => current === old, element))
    )
      return { reason: 'replaced', matches, detail };
    throw failure;
  } finally {
    await element?.dispose();
  }
}

async function scrollElement(
  page: Page,
  point: ScrollPoint,
  direction: 'up' | 'down',
): Promise<Element | null> {
  const result = await page.evaluateHandle(scrollGeometry, {
    point,
    direction,
  });
  const handle = await result.getProperty('recipient');
  await result.dispose();
  const element = handle.asElement() as Element | null;
  if (!element) await handle.dispose();
  return element;
}

async function bind(
  page: Page,
  action: Action,
  visibleDialogs: Element[],
): Promise<Skip | null> {
  const url = page.url();
  if (action.kind === 'wait') {
    guards.set(action, { kind: 'wait', url });
    return null;
  }
  if (action.kind === 'back') {
    const history = await navigationHistory(page);
    if (!history || history.previous !== action.url)
      return { reason: 'replaced' };
    guards.set(action, {
      kind: 'back',
      url,
      target: action.url,
      index: history.index,
    });
    return null;
  }
  if (action.kind === 'scroll') {
    const element = await scrollElement(page, action.point, action.direction);
    if (!element) return { reason: 'no_recipient' };
    const { x, y } = await element.evaluate((element) => ({
      x: element.scrollLeft,
      y: element.scrollTop,
    }));
    guards.set(action, {
      kind: 'scroll',
      url,
      element,
      x,
      y,
      ...page.viewportSize()!,
      dialogs: visibleDialogs,
      point: { ...action.point },
      direction: action.direction,
    });
    return null;
  }
  return bindControl(locate(page, action.target), (element, state) =>
    guards.set(action, {
      kind: 'control',
      url,
      element,
      state,
      dialogs: visibleDialogs,
    }),
  );
}

export function locate(page: Page, target: Target): Locator {
  switch (target.by) {
    case 'testId':
      return page.getByTestId(target.value);
    case 'label':
      return page.getByLabel(target.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(target.value, { exact: true });
    case 'css':
      return page.locator(target.value);
    case 'role':
      return page.getByRole(target.role, { name: target.name, exact: true });
  }
}

async function inViewport(page: Page, locator: Locator): Promise<boolean> {
  if (!(await locator.isVisible())) return false;
  return (await locator.evaluate(projectViewport)).targetVisible;
}

// Viewport visibility plus the name the observation reports for the element,
// or null when it is not visible in the viewport.
async function visibleName(element: Element): Promise<string | null> {
  if (!(await element.isVisible())) return null;
  const projection = await element.evaluate(projectViewport);
  return projection.targetVisible ? (projection.targetName ?? '') : null;
}

// Observed-control names of the actions offered by the last candidates() call.
const offeredNames = new WeakMap<Page, string[]>();
export function offeredControls(page: Page): string[] {
  return offeredNames.get(page) ?? [];
}

const connected = (element: Element) =>
  element.evaluate((element) => element.isConnected);

// isEnabled throws on a detached handle; report that as absence, not failure.
async function enabled(element: Element): Promise<boolean | null> {
  try {
    return await element.isEnabled();
  } catch (caught) {
    if (!(await connected(element))) return null;
    throw caught;
  }
}

// The accessible name from the first line of an aria snapshot. Playwright emits
// `- role "name"` with JSON-style escapes, and wraps the whole line in YAML
// single quotes (doubling inner ') when the name contains YAML-significant text
// such as ': ' or ' #'. A trailing ':' marks child nodes.
export function snapshotName(snapshot: string): string | null {
  let line = snapshot.split('\n')[0]!.trim().replace(/^- /, '');
  if (line.startsWith("'")) {
    line = line.replace(/:$/, '');
    if (!line.endsWith("'") || line.length < 2) return null;
    line = line.slice(1, -1).replace(/''/g, "'");
  }
  const match = line.match(/^[a-z]+ "((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

// Reads a discovered control's accessibility snapshot through its current
// position, so a removed sibling cannot shift the read onto a neighbour.
async function snapshotOf(
  all: Locator,
  element: Element,
): Promise<{ snapshot: string } | Skip> {
  const indexOf = () =>
    all.evaluateAll((elements, element) => elements.indexOf(element), element);
  for (let attempt = 0; ; attempt++) {
    const index = await indexOf();
    if (index < 0) return { reason: 'detached' };
    const control = all.nth(index);
    let failure: unknown = null;
    try {
      const snapshot = await control.ariaSnapshot({
        timeout: CAPTURE_TIMEOUT_MS,
      });
      if (
        await control.evaluate((current, old) => current === old, element, {
          timeout: CAPTURE_TIMEOUT_MS,
        })
      )
        return { snapshot };
    } catch (caught) {
      failure = caught;
    }
    const now = await indexOf();
    if (now < 0)
      return {
        reason: 'detached',
        detail: failure ? firstLine(failure) : undefined,
      };
    // Nothing moved, so the failure belongs to this control: surface it.
    if (now === index && failure) throw failure;
    if (attempt === 1)
      return {
        reason: 'replaced',
        detail: failure ? firstLine(failure) : undefined,
      };
  }
}

async function scrollState(page: Page): Promise<Observation['scroll']> {
  return page.evaluate(() => {
    const roots: ParentNode[] = [document];
    const elements: globalThis.Element[] = [];
    for (let index = 0; index < roots.length; index++) {
      for (const element of Array.from(roots[index]!.querySelectorAll('*'))) {
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return {
      x: window.scrollX,
      y: window.scrollY,
      containers: elements.flatMap((element, index) =>
        element.scrollTop || element.scrollLeft
          ? [{ index, x: element.scrollLeft, y: element.scrollTop }]
          : [],
      ),
    };
  });
}

export function allowedURL(
  value: string,
  baseURL: string,
  paths: string[],
  origins: string[] = [],
): boolean {
  try {
    const url = new URL(value, baseURL);
    if (
      ![
        new URL(baseURL).origin,
        ...origins.map((origin) => new URL(origin).origin),
      ].includes(url.origin) ||
      url.username ||
      url.password
    )
      return false;
    const pathname = decodeURIComponent(url.pathname);
    if (/(^|\/)(auth|login|logout|sign-out)(\/|$)/i.test(pathname))
      return false;
    return paths.some((path) =>
      path === '/'
        ? pathname === '/'
        : pathname === path || pathname.startsWith(`${path}/`),
    );
  } catch {
    return false;
  }
}

export function allowedRequest(
  request: Pick<Request, 'method' | 'url'>,
  suite: Suite,
): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return true;
  const url = new URL(request.url());
  if (
    suite.allowedRequests.some(
      (rule) =>
        request.method() === rule.method &&
        url.origin === new URL(rule.origin).origin &&
        (rule.path
          ? url.pathname === rule.path
          : new RegExp(rule.pathPattern!).test(url.pathname)),
    )
  )
    return true;
  return (
    request.method() === 'POST' &&
    suite.readOnlyPosts.some(
      (rule) =>
        url.origin === new URL(rule.origin).origin &&
        url.pathname === rule.path,
    )
  );
}

export async function check(page: Page, condition: Check): Promise<boolean> {
  if (condition.kind === 'path')
    return new RegExp(condition.pattern).test(new URL(page.url()).pathname);
  const target = locate(page, condition.target);
  if (condition.kind === 'notVisible') {
    for (const element of await target.all())
      if (await element.isVisible()) return false;
    return true;
  }
  if (condition.kind === 'anyVisible' || condition.kind === 'anyRendered') {
    for (const element of await target.all())
      if (
        condition.kind === 'anyRendered'
          ? await element.isVisible()
          : await inViewport(page, element)
      )
        return true;
    return false;
  }
  if ((await target.count()) !== 1 || !(await inViewport(page, target)))
    return false;
  return (
    condition.kind === 'visible' ||
    new RegExp(condition.pattern).test(await target.innerText())
  );
}

export async function observe(
  page: Page,
  step: number,
  screenshotPath: string,
): Promise<Observation> {
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const snapshot = await page.locator('body').ariaSnapshot();
  const horizontalOverflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  );
  const url = page.url();
  const scroll = await scrollState(page);
  const { targetVisible: _targetVisible, ...viewport } = await page.evaluate(
    projectViewport,
    null,
  );
  viewport.scrollRegions = (await page.evaluate(scrollGeometry, null)).regions;
  viewport.canScrollUp = viewport.scrollRegions.some(
    (region) => region.up !== null,
  );
  viewport.canScrollDown = viewport.scrollRegions.some(
    (region) => region.down !== null,
  );
  const fingerprint = createHash('sha256')
    .update(url + snapshot + JSON.stringify(scroll))
    .digest('hex');
  return {
    step,
    url,
    snapshot: snapshot.slice(0, 20000),
    screenshot: screenshotPath,
    visibleViewport: viewport,
    fingerprint,
    scroll,
    horizontalOverflow,
  };
}

export async function candidates(
  page: Page,
  journey: Journey,
  baseURL: string,
  origins: string[] = [],
  log?: EventLogger,
): Promise<Action[]> {
  await releaseActions(page);
  const out: Action[] = [];
  // Discovery reads through element handles: a removed element stays the same
  // (detached) object instead of shifting nth() reads onto its neighbour.
  const discovered: Element[] = [];
  // Observed-control name per discovered action, for planner scope hints.
  const names = new Map<Action, string>();
  const skip = (skipped: Skip & { role: string; name?: string }) =>
    log?.('candidate_skipped', {
      journey: journey.id,
      url: page.url(),
      phase: 'discovery',
      ...skipped,
    });
  try {
    const counts = new Map<string, number>();
    const observed: { name: string; href: string; control: string }[] = [];
    const links = (await page.getByRole('link').elementHandles()) as Element[];
    discovered.push(...links);
    for (const link of links) {
      const control = await visibleName(link);
      if (control === null) continue;
      // One evaluation reads every field from the same element.
      const read = await link.evaluate((element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        const name =
          element.getAttribute('aria-label') ??
          (labelledBy
            ? labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join(' ')
            : null) ??
          (element.textContent?.trim() || element.getAttribute('title') || '');
        return {
          name,
          href: element.getAttribute('href'),
          target: element.getAttribute('target'),
          connected: element.isConnected,
        };
      });
      if (!read.connected) {
        await skip({ role: 'link', name: read.name, reason: 'detached' });
        continue;
      }
      let resolved: string;
      try {
        resolved = new URL(read.href ?? '', page.url()).href;
      } catch {
        continue;
      }
      if (
        !read.name ||
        !read.href ||
        !allowedURL(resolved, baseURL, journey.allowedPaths, origins) ||
        read.target === '_blank'
      )
        continue;
      counts.set(read.name, (counts.get(read.name) ?? 0) + 1);
      observed.push({ name: read.name, href: resolved, control });
    }
    for (const link of observed) {
      const target: Target = { by: 'role', role: 'link', name: link.name };
      if (
        counts.get(link.name) === 1 &&
        (await locate(page, target).count()) === 1
      ) {
        const action: Action = {
          kind: 'link',
          id: `a${out.length}`,
          description: `Open ${link.name}`,
          target,
          href: link.href,
        };
        names.set(action, link.control);
        out.push(action);
      }
    }
    for (const interaction of journey.interactions) {
      const target = locate(page, interaction.target);
      if ((await target.count()) !== 1) continue;
      let element: Element | null = null;
      try {
        element = (await target.elementHandle({
          timeout: CAPTURE_TIMEOUT_MS,
        })) as Element | null;
      } catch (caught) {
        if (!(caught instanceof errors.TimeoutError)) throw caught;
      }
      if (!element) {
        await skip({
          role: 'interaction',
          name: interaction.description,
          reason: 'detached',
        });
        continue;
      }
      discovered.push(element);
      const control = await visibleName(element);
      if (control === null) continue;
      const usable = await enabled(element);
      if (usable === null)
        await skip({
          role: 'interaction',
          name: interaction.description,
          reason: 'detached',
        });
      if (usable) {
        const action: Action = { ...interaction, id: `a${out.length}` };
        names.set(action, control);
        out.push(action);
      }
    }
    for (const role of journey.discoverRoles) {
      const all = page.getByRole(role);
      const controls = (await all.elementHandles()) as Element[];
      discovered.push(...controls);
      for (const control of controls) {
        const controlName = await visibleName(control);
        if (controlName === null) continue;
        const usable = await enabled(control);
        if (usable === null) await skip({ role, reason: 'detached' });
        if (!usable) continue;
        const read = await snapshotOf(all, control);
        if (!('snapshot' in read)) {
          await skip({ role, ...read });
          continue;
        }
        const name = snapshotName(read.snapshot);
        if (name === null) continue;
        const target: Target = { by: 'role', role, name };
        if (
          (await locate(page, target).count()) !== 1 ||
          out.some(
            (action) =>
              'target' in action &&
              JSON.stringify(action.target) === JSON.stringify(target),
          )
        )
          continue;
        const action: Action = {
          kind: 'click',
          id: `a${out.length}`,
          target,
          description: `Click ${role} ${name}`,
        };
        names.set(action, controlName);
        out.push(action);
      }
    }
  } finally {
    await Promise.allSettled(discovered.map((element) => element.dispose()));
  }
  const { regions } = await page.evaluate(scrollGeometry, null);
  for (const region of regions) {
    for (const direction of ['down', 'up'] as const) {
      const point = region[direction];
      if (!point) continue;
      out.push({
        kind: 'scroll',
        id: `a${out.length}`,
        description: `Scroll ${direction} in ${region.label} (${region.id}, ${region.parent ? `inside ${region.parent}` : 'outer region'})`,
        direction,
        region: region.id,
        point,
      });
    }
  }
  const history = await navigationHistory(page);
  if (
    history?.previous &&
    allowedURL(history.previous, baseURL, journey.allowedPaths, origins)
  ) {
    const previous = new URL(history.previous);
    out.push({
      kind: 'back',
      id: `a${out.length}`,
      description: `Go back to the previous page (${previous.pathname}${previous.search})`,
      url: history.previous,
    });
  }
  out.push({
    kind: 'wait',
    id: `a${out.length}`,
    description: 'Wait briefly for loading to finish',
  });
  const visibleDialogs = await dialogs(page);
  offeredActions.set(page, { actions: out, dialogs: visibleDialogs });
  const offered: Action[] = [];
  for (const action of out) {
    const skipped = await bind(page, action, visibleDialogs);
    if (!skipped) offered.push(action);
    // Never offer an action without a guard; record why it was withdrawn.
    else
      await log?.('candidate_skipped', {
        journey: journey.id,
        url: page.url(),
        phase: 'capture',
        action: action.description,
        kind: action.kind,
        ...skipped,
      });
  }
  offered.forEach((action, index) => {
    action.id = `a${index}`;
  });
  offeredNames.set(
    page,
    offered.flatMap((action) =>
      names.has(action) ? [names.get(action)!] : [],
    ),
  );
  return offered;
}

export async function repeatState(
  page: Page,
  action: Action,
  journey: Journey,
): Promise<string | null> {
  const guard = guards.get(action);
  if (!guard || guard.kind === 'wait') return null;
  const progress = [];
  for (const configured of journey.loopProgressTargets ?? []) {
    const target = locate(page, configured);
    const count = await target.count();
    if (count > 1)
      throw new Error(
        'Loop progress target is ambiguous; configure a unique target',
      );
    const visible = count === 1 && (await target.isVisible());
    progress.push({
      count,
      visible,
      snapshot: visible ? (await target.ariaSnapshot()).slice(0, 20000) : null,
    });
  }
  if (guard.kind === 'back')
    return JSON.stringify({
      url: guard.url,
      recipient: { back: guard.target, index: guard.index },
      dialogNames: [],
      progress,
    });
  const dialogNames = await Promise.all(
    guard.dialogs.map((dialog) =>
      dialog.evaluate((element) => ({
        role: element.getAttribute('role'),
        name:
          element.getAttribute('aria-label') ??
          (element.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/)
            .map(
              (id) =>
                element.ownerDocument.getElementById(id)?.textContent ?? '',
            )
            .join(' '),
      })),
    ),
  );
  const recipient =
    guard.kind === 'control'
      ? guard.state
      : await guard.element.evaluate((element) => ({
          x: element.scrollLeft,
          y: element.scrollTop,
          width: element.clientWidth,
          height: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
        }));
  return JSON.stringify({ url: guard.url, recipient, dialogNames, progress });
}

export async function execute(
  page: Page,
  action: Action,
  before: Observation,
  journey: Journey,
  baseURL: string,
  origins: string[] = [],
): Promise<void> {
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
  if (action.kind === 'back') {
    const history = await navigationHistory(page);
    if (
      guard.kind !== 'back' ||
      !history ||
      history.index !== guard.index ||
      history.previous !== guard.target
    )
      throw new Error(
        'Stale observation: browser history changed during selection',
      );
    if (!allowedURL(guard.target, baseURL, journey.allowedPaths, origins))
      throw new Error('Selected history entry left the journey scope');
    await page.goBack({ waitUntil: 'commit' });
    if (!allowedURL(page.url(), baseURL, journey.allowedPaths, origins))
      throw new Error('Navigation left the journey scope');
    return;
  }
  if (action.kind === 'scroll') {
    const viewport = page.viewportSize()!;
    if (
      guard.kind !== 'scroll' ||
      viewport.width !== guard.width ||
      viewport.height !== guard.height ||
      action.direction !== guard.direction ||
      action.point.x !== guard.point.x ||
      action.point.y !== guard.point.y
    )
      throw new Error(
        'Stale observation: scroll context changed during selection',
      );
    await page.mouse.move(guard.point.x, guard.point.y);
    if (page.url() !== guard.url || !(await sameDialogs(page, guard.dialogs)))
      throw new Error(
        'Stale observation: scroll context changed during selection',
      );
    const current = await scrollElement(page, guard.point, guard.direction);
    try {
      if (
        !current ||
        !(await current.evaluate(
          (element, old) => element === old,
          guard.element,
        )) ||
        !(await current.evaluate(
          (element, state) =>
            element.scrollLeft === state.x && element.scrollTop === state.y,
          { x: guard.x, y: guard.y },
        ))
      )
        throw new Error(
          'Stale observation: scroll container or position changed during selection',
        );
    } finally {
      await current?.dispose();
    }
    await page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
    // Wheel returns before scrolling finishes. Chromium ends its synthetic
    // wheel transaction after 500ms; let it settle before observing or switching
    // regions, otherwise the next wheel can remain latched to the old panel.
    // https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/renderer_host/input/mouse_wheel_phase_handler.h
    await page.waitForTimeout(550);
    return;
  }
  const target = locate(page, action.target);
  if (
    (await target.count()) !== 1 ||
    !(await inViewport(page, target)) ||
    !(await target.isEnabled())
  )
    throw new Error(
      'Stale observation: selected target is unavailable or ambiguous',
    );
  if (
    guard.kind !== 'control' ||
    !(await sameDialogs(page, guard.dialogs)) ||
    !(await target.evaluate(
      (element, old) => element === old,
      guard.element,
    )) ||
    (await controlState(target)) !== guard.state
  )
    throw new Error(
      'Stale observation: selected target or dialog context changed during selection',
    );
  if (action.kind === 'link') {
    const href = await target.getAttribute('href');
    if (
      !href ||
      new URL(href, page.url()).href !== action.href ||
      !allowedURL(action.href, baseURL, journey.allowedPaths, origins)
    )
      throw new Error('Selected link changed or left the journey scope');
    await guard.element.click();
  } else if (action.kind === 'click') await guard.element.click();
  else if (action.kind === 'fill') await guard.element.fill(action.value);
  else if (action.kind === 'select')
    await guard.element.selectOption(action.value);
  else if (action.kind === 'check')
    await guard.element.setChecked(action.checked);
  else await guard.element.press(action.key);
  if (!allowedURL(page.url(), baseURL, journey.allowedPaths, origins))
    throw new Error('Navigation left the journey scope');
}
