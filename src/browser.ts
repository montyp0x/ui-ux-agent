import { createHash } from 'node:crypto';
import type { ElementHandle, Locator, Page, Request } from 'playwright';
import type {
  Action,
  Check,
  Journey,
  Observation,
  Suite,
  Target,
} from './contracts.js';
import { projectViewport } from './viewport.js';

type Element = ElementHandle<HTMLElement | SVGElement>;
type Guard =
  | { kind: 'wait'; url: string }
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
    };
const guards = new WeakMap<Action, Guard>();
const offeredActions = new WeakMap<Page, Action[]>();

async function releaseActions(page: Page): Promise<void> {
  const elements = new Set<Element>();
  for (const action of offeredActions.get(page) ?? []) {
    const guard = guards.get(action);
    if (guard && guard.kind !== 'wait') {
      elements.add(guard.element);
      guard.dialogs.forEach((element) => elements.add(element));
    }
    guards.delete(action);
  }
  offeredActions.delete(page);
  await Promise.allSettled([...elements].map((element) => element.dispose()));
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

async function controlState(target: Locator): Promise<string> {
  return JSON.stringify({
    snapshot: await target.ariaSnapshot(),
    properties: await target.evaluate((element) => {
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
    }),
  });
}

async function scrollElement(page: Page): Promise<Element> {
  const viewport = page.viewportSize()!;
  const handle = await page.evaluateHandle(
    ({ x, y }) => {
      for (
        let element = document.elementFromPoint(x, y);
        element;
        element = element.parentElement
      ) {
        const style = getComputedStyle(element);
        if (
          /auto|scroll/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight
        )
          return element;
      }
      return document.scrollingElement ?? document.documentElement;
    },
    { x: viewport.width / 2, y: viewport.height * 0.7 },
  );
  return handle.asElement() as Element;
}

async function bind(
  page: Page,
  action: Action,
  visibleDialogs: Element[],
): Promise<void> {
  const url = page.url();
  if (action.kind === 'wait') {
    guards.set(action, { kind: 'wait', url });
    return;
  }
  if (action.kind === 'scroll') {
    const element = await scrollElement(page);
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
    });
  } else {
    const target = locate(page, action.target);
    const element = await target.elementHandle();
    if (element)
      guards.set(action, {
        kind: 'control',
        url,
        element,
        state: await controlState(target),
        dialogs: visibleDialogs,
      });
  }
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

async function scrollState(page: Page): Promise<Observation['scroll']> {
  return page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    containers: Array.from(document.querySelectorAll('*')).flatMap(
      (element, index) =>
        element.scrollTop || element.scrollLeft
          ? [{ index, x: element.scrollLeft, y: element.scrollTop }]
          : [],
    ),
  }));
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
        url.pathname === rule.path,
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
  if (condition.kind === 'anyVisible') {
    for (const element of await target.all())
      if (await inViewport(page, element)) return true;
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
): Promise<Action[]> {
  await releaseActions(page);
  const out: Action[] = [];
  const links = page.getByRole('link');
  const counts = new Map<string, number>();
  const observed: { name: string; href: string }[] = [];
  for (const link of await links.all()) {
    if (!(await inViewport(page, link))) continue;
    const name = await link.evaluate((element) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      return (
        element.getAttribute('aria-label') ??
        (labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' ')
          : null) ??
        (element.textContent?.trim() || element.getAttribute('title') || '')
      );
    });
    const href = await link.getAttribute('href');
    let resolved: string;
    try {
      resolved = new URL(href ?? '', page.url()).href;
    } catch {
      continue;
    }
    if (
      !name ||
      !href ||
      !allowedURL(resolved, baseURL, journey.allowedPaths, origins) ||
      (await link.getAttribute('target')) === '_blank'
    )
      continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    observed.push({ name, href: resolved });
  }
  for (const link of observed) {
    const target: Target = { by: 'role', role: 'link', name: link.name };
    if (
      counts.get(link.name) === 1 &&
      (await locate(page, target).count()) === 1
    )
      out.push({
        kind: 'link',
        id: `a${out.length}`,
        description: `Open ${link.name}`,
        target,
        href: link.href,
      });
  }
  for (const interaction of journey.interactions) {
    const target = locate(page, interaction.target);
    if (
      (await target.count()) === 1 &&
      (await inViewport(page, target)) &&
      (await target.isEnabled())
    )
      out.push({ ...interaction, id: `a${out.length}` });
  }
  for (const role of journey.discoverRoles) {
    for (const control of await page.getByRole(role).all()) {
      if (!(await inViewport(page, control)) || !(await control.isEnabled()))
        continue;
      const snapshot = await control.ariaSnapshot();
      const match = snapshot.match(/^\s*- [a-z]+ "((?:\\.|[^"\\])*)"/);
      if (!match) continue;
      let name: string;
      try {
        name = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        continue;
      }
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
      out.push({
        kind: 'click',
        id: `a${out.length}`,
        target,
        description: `Click ${role} ${name}`,
      });
    }
  }
  const viewport = await page.evaluate(projectViewport, null);
  if (viewport.canScrollDown)
    out.push({
      kind: 'scroll',
      id: `a${out.length}`,
      description: 'Scroll down to find more content',
      direction: 'down',
    });
  if (viewport.canScrollUp)
    out.push({
      kind: 'scroll',
      id: `a${out.length}`,
      description: 'Scroll up to earlier content',
      direction: 'up',
    });
  out.push({
    kind: 'wait',
    id: `a${out.length}`,
    description: 'Wait briefly for loading to finish',
  });
  offeredActions.set(page, out);
  const visibleDialogs = await dialogs(page);
  for (const action of out) await bind(page, action, visibleDialogs);
  return out;
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
  if (action.kind === 'scroll') {
    const viewport = page.viewportSize()!;
    if (
      guard.kind !== 'scroll' ||
      viewport.width !== guard.width ||
      viewport.height !== guard.height ||
      !(await sameDialogs(page, guard.dialogs))
    )
      throw new Error(
        'Stale observation: scroll context changed during selection',
      );
    const current = await scrollElement(page);
    try {
      if (
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
      await current.dispose();
    }
    await page.mouse.move(viewport.width / 2, viewport.height * 0.7);
    await page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
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
