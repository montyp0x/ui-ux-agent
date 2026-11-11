import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_BLOCKED_CONTROLS,
  EXCLUDED_MENUS,
  MENU_BLOCKED_CONTROLS,
  type Action,
  type Check,
  type Observation,
  type Suite,
  type Target,
} from '../contracts.js';
import type { UIDriver, UISession } from './types.js';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(root, 'native', 'macos', 'ax-helper.swift');
const binary = join(root, '.build', 'ax-helper');

// Builds the accessibility helper when it is missing or older than its source.
export async function ensureHelper(): Promise<string> {
  if (process.platform !== 'darwin')
    throw new Error('The macOS driver runs only on macOS');
  if (
    !existsSync(binary) ||
    statSync(binary).mtimeMs < statSync(source).mtimeMs
  ) {
    await mkdir(dirname(binary), { recursive: true });
    await run('swiftc', ['-O', source, '-o', binary]);
  }
  return binary;
}

type Frame = { x: number; y: number; width: number; height: number };
export type AXNode = {
  ref: number;
  parent?: number;
  depth: number;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  value?: string;
  identifier?: string;
  help?: string;
  placeholder?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  frame?: Frame;
  // Derived for rows (lists, tables, outlines): their descendants' text.
  rowText?: string;
  actions: string[];
};
type Snapshot = {
  window: { title: string; frame: Frame; number: number };
  elements: AXNode[];
  truncated: boolean;
  frontmost: { bundleId: string; pid: number };
};

class Helper {
  private process: ChildProcessWithoutNullStreams;
  private pending: ((value: Record<string, unknown>) => void)[] = [];
  private queue = Promise.resolve();
  constructor(path: string) {
    this.process = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      this.pending.shift()?.(JSON.parse(line) as Record<string, unknown>);
    });
  }
  // One request at a time; the helper answers in order.
  call<T = Record<string, unknown>>(
    request: Record<string, unknown>,
  ): Promise<T> {
    const result = this.queue.then(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          this.pending.push(resolve);
          this.process.stdin.write(JSON.stringify(request) + '\n');
        }),
    );
    this.queue = result.then(() => undefined);
    return result.then((response) => {
      if (typeof response.error === 'string') throw new Error(response.error);
      return response as T;
    });
  }
  close() {
    this.process.stdin.end();
    this.process.kill();
  }
}

// Bidirectional marks (Calculator writes U+200E around digits) and whitespace runs.
const clean = (text: string | undefined) =>
  (text ?? '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const ROLES: Record<string, string> = {
  AXButton: 'button',
  AXMenuButton: 'button',
  AXDisclosureTriangle: 'button',
  AXLink: 'link',
  AXTextField: 'textbox',
  AXTextArea: 'textbox',
  AXSecureTextField: 'textbox',
  AXComboBox: 'combobox',
  AXPopUpButton: 'combobox',
  AXCheckBox: 'checkbox',
  AXSwitch: 'checkbox',
  AXRadioButton: 'radio',
  AXMenuItem: 'menuitem',
  AXHeading: 'heading',
  AXSheet: 'dialog',
  AXStaticText: 'text',
  AXImage: 'image',
  AXRow: 'option',
};
export function roleOf(node: AXNode): string {
  if (node.subrole === 'AXTabButton') return 'tab';
  if (node.subrole === 'AXSearchField') return 'searchbox';
  if (node.subrole === 'AXSwitch') return 'checkbox';
  if (node.subrole === 'AXDialog') return 'dialog';
  return ROLES[node.role] ?? node.role.replace(/^AX/, '').toLowerCase();
}
export function nameOf(node: AXNode): string {
  const role = roleOf(node);
  return clean(
    node.title ||
      node.rowText ||
      node.description ||
      (role === 'text' || role === 'heading' ? node.value : undefined) ||
      node.help ||
      '',
  );
}

function intersect(a: Frame, b: Frame): Frame | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

// Visible when the frame is inside the window and every enclosing scroll area.
export function visibleNodes(snapshot: Snapshot): Set<number> {
  const byRef = new Map(snapshot.elements.map((node) => [node.ref, node]));
  const visible = new Set<number>();
  for (const node of snapshot.elements) {
    if (!node.frame || node.frame.width <= 0 || node.frame.height <= 0)
      continue;
    let area: Frame | null = intersect(node.frame, snapshot.window.frame);
    for (
      let parent = node.parent;
      area && parent !== undefined;
      parent = byRef.get(parent)?.parent
    ) {
      const ancestor = byRef.get(parent);
      if (ancestor?.role === 'AXScrollArea' && ancestor.frame)
        area = intersect(area, ancestor.frame);
    }
    if (area) visible.add(node.ref);
  }
  return visible;
}

// An element's text content, like innerText: its own value, else its
// descendants' static text, else its name.
export function textOf(snap: Snapshot, node: AXNode): string {
  const own = clean(node.value);
  if (own) return own;
  const inside = new Set([node.ref]);
  const parts: string[] = [];
  for (const child of snap.elements)
    if (child.parent !== undefined && inside.has(child.parent)) {
      inside.add(child.ref);
      if (
        ['AXStaticText', 'AXHeading'].includes(child.role) &&
        clean(child.value)
      )
        parts.push(clean(child.value));
    }
  return parts.join(' ') || nameOf(node);
}

export function matches(node: AXNode, target: Target): boolean {
  switch (target.by) {
    case 'role':
      return roleOf(node) === target.role && nameOf(node) === target.name;
    case 'testId':
      return node.identifier === target.value;
    case 'label':
      // A label is visible text naming something: description, title, or the
      // value of a static text element.
      return (
        clean(node.description) === target.value ||
        clean(node.title) === target.value ||
        (node.role === 'AXStaticText' && clean(node.value) === target.value)
      );
    case 'placeholder':
      return clean(node.placeholder) === target.value;
    case 'css':
      return false;
  }
}

// Title-bar buttons are window management, not application UI.
const CHROME = new Set([
  'AXCloseButton',
  'AXMinimizeButton',
  'AXZoomButton',
  'AXFullScreenButton',
]);
const isChrome = (node: AXNode) => CHROME.has(node.subrole ?? '');

const PRESSABLE = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'combobox',
]);

type Guard =
  | { kind: 'wait' }
  | {
      kind: 'control';
      ref: number;
      signature: string;
      title: string;
      // Rows are selected (AXSelected) rather than pressed.
      select?: boolean;
      // Menu commands are re-checked by title instead of the full signature.
      menu?: string;
    }
  | {
      kind: 'scroll';
      ref: number;
      bar: number | null;
      value: number | null;
      // Scroll bar distance of about one visible page, for the fallback.
      page: number;
      title: string;
    };

// The fraction of the scrollable range that one visible page covers, from the
// area's height and the extent of its descendants' frames.
function pageFraction(snap: Snapshot, area: AXNode): number {
  const top = area.frame?.y ?? 0;
  const height = area.frame?.height ?? 0;
  const inside = new Set([area.ref]);
  let bottom = top + height;
  for (const node of snap.elements)
    if (node.parent !== undefined && inside.has(node.parent)) {
      inside.add(node.ref);
      if (node.role !== 'AXScrollBar' && node.frame)
        bottom = Math.max(bottom, node.frame.y + node.frame.height);
    }
  const range = bottom - top - height;
  return range > 0 ? Math.min(1, (height * 0.9) / range) : 1;
}

function verticalBar(snap: Snapshot, area: AXNode): AXNode | undefined {
  return snap.elements.find(
    (node) =>
      node.parent === area.ref &&
      node.role === 'AXScrollBar' &&
      node.subrole !== 'AXHorizontalScrollBar' &&
      node.value !== undefined &&
      (!node.frame || node.frame.height >= node.frame.width),
  );
}

const signature = (node: AXNode) =>
  JSON.stringify([
    node.role,
    node.subrole,
    node.title,
    node.description,
    node.identifier,
    node.enabled,
  ]);

export async function macosDriver(): Promise<UIDriver> {
  const helper = new Helper(await ensureHelper());
  const status = await helper.call<{
    accessibility: boolean;
    screenCapture: boolean;
  }>({ cmd: 'status' });
  if (!status.accessibility || !status.screenCapture)
    throw new Error(
      'macOS needs Accessibility and Screen Recording permission for the app running this process (System Settings → Privacy & Security)',
    );
  return {
    async openSession({ suite, journey, viewport, log }) {
      let pid = 0;
      let bundleId = suite.app?.bundleId ?? '';
      let timeoutMs = 5000;
      let lastURL = suite.baseURL;
      let last: Snapshot | null = null;
      const guards = new WeakMap<Action, Guard>();
      let offeredNames: string[] = [];
      const blocked = [
        ...DEFAULT_BLOCKED_CONTROLS,
        ...suite.blockedControls,
      ].map((pattern) => new RegExp(pattern, 'i'));
      const urlOf = (title: string) =>
        `${suite.baseURL}/${encodeURIComponent(title)}`;
      // Electron/Chromium apps expose their web content only after an assistive
      // client asks (AXManualAccessibility), and the tree can go dormant again;
      // a near-empty snapshot re-asks, at most every 5s. Other apps reject the
      // attribute: they are asked once and never waited on, so a small native
      // window is not delayed or switched into AXEnhancedUserInterface mode.
      let lastEnable = 0;
      let manualAccessibility: boolean | undefined;
      const enableTree = async (enhanced: boolean) => {
        lastEnable = Date.now();
        const result = await helper
          .call<{ manual?: number; enhanced?: number }>({
            cmd: 'enableAccessibility',
            pid,
            enhanced,
          })
          .catch((error: Error) => ({ error: error.message }));
        // 0 is kAXErrorSuccess: the app supports the attribute.
        if (!enhanced)
          manualAccessibility = 'manual' in result && result.manual === 0;
        await log('accessibility_enabled', {
          journey: journey.id,
          enhanced,
          result,
        });
      };
      const snapshot = async () => {
        last = await helper.call<Snapshot>({ cmd: 'snapshot', pid });
        if (
          last.elements.length < 30 &&
          manualAccessibility !== false &&
          Date.now() - lastEnable > 5000
        ) {
          const before = last.elements.length;
          await enableTree(false);
          if (manualAccessibility) {
            for (let i = 0; i < 10 && last.elements.length < 30; i++) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              last = await helper.call<Snapshot>({ cmd: 'snapshot', pid });
            }
            if (last.elements.length < 30) {
              await enableTree(true);
              await new Promise((resolve) => setTimeout(resolve, 1500));
              last = await helper.call<Snapshot>({ cmd: 'snapshot', pid });
            }
            await log('accessibility_tree', {
              journey: journey.id,
              before,
              after: last.elements.length,
            });
          }
        }
        for (const node of last.elements)
          if (node.role === 'AXRow' && !node.title && !node.description)
            node.rowText = textOf(last, node);
        lastURL = urlOf(last.window.title);
        return last;
      };
      // Accessibility actions target the app's own elements, so the app may run
      // behind the user's work. The journey leaves scope when an action brings a
      // different app to the front (e.g. "open in browser") or the app quits.
      let leftScope = false;
      const frontmost = () =>
        helper.call<{ bundleId: string; pid: number }>({ cmd: 'frontmost' });
      const inScope = async () => {
        if (leftScope) return false;
        // A quit app is gone at once. A running app may have no window for a
        // moment (one closes before the next opens, or accessibility answers
        // empty under load), so wait up to 2s for a window to appear.
        // Accessibility may also list no window while the window server still
        // shows one (the helper then answers source "windowServer").
        const started = Date.now();
        for (let probes = 1; ; probes++) {
          const probe = await helper.call<{
            alive: boolean;
            running: boolean;
            source?: string;
            uncertain?: boolean;
            registered?: boolean;
          }>({ cmd: 'alive', pid });
          if (probe.alive) {
            if (probes > 1 || probe.source || probe.registered === false)
              await log('scope_probe', {
                journey: journey.id,
                inScope: true,
                probes,
                waitedMs: Date.now() - started,
                source: probe.source ?? 'accessibility',
                registered: probe.registered,
              });
            return true;
          }
          if (!probe.running || Date.now() - started > 2000) {
            await log('scope_probe', {
              journey: journey.id,
              inScope: false,
              probes,
              waitedMs: Date.now() - started,
              running: probe.running,
              registered: probe.registered,
            });
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      };
      const find = (snap: Snapshot, target: Target) => {
        const visible = visibleNodes(snap);
        const all = snap.elements.filter((node) => matches(node, target));
        return { all, visible: all.filter((node) => visible.has(node.ref)) };
      };
      const session: UISession = {
        driver: 'macos' as const,
        browserErrors: [],
        unauthorized: false,
        policyBlocks: [],
        async start(timeout) {
          if (suite.app?.relaunch) {
            if (!suite.app.bundleId)
              throw new Error('relaunch needs app.bundleId');
            await helper.call({
              cmd: 'terminate',
              bundleId: suite.app.bundleId,
            });
          }
          const launched = await helper.call<{ pid: number; bundleId: string }>(
            {
              cmd: 'launch',
              ...(suite.app?.path
                ? { path: suite.app.path }
                : { bundleId: suite.app?.bundleId }),
            },
          );
          pid = launched.pid;
          bundleId = launched.bundleId || bundleId;
          const deadline = Date.now() + timeout;
          // Wait for an accessible window with a window-server id. Activation is
          // attempted (Apple Events, validated bundle id; macOS 14+ ignores
          // background activation) but not required: actions and window
          // captures work while another app is in front.
          const activate = async () => {
            await helper.call({ cmd: 'activate', pid }).catch(() => undefined);
            if (/^[A-Za-z0-9.-]+$/.test(bundleId))
              await run(
                'osascript',
                ['-e', `tell application id "${bundleId}" to activate`],
                {
                  timeout: 5000,
                },
              ).catch(() => undefined);
          };
          await activate();
          for (;;) {
            try {
              const snap = await snapshot();
              if (snap.window.number > 0 && snap.window.frame.width > 0) break;
              await activate();
              if (Date.now() > deadline)
                throw new Error(
                  `The application window did not appear (window ${snap.window.number}, frontmost ${snap.frontmost.bundleId} pid ${snap.frontmost.pid}, launched pid ${pid})`,
                );
            } catch (caught) {
              if (Date.now() > deadline) throw caught;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const resized = await helper
            .call({
              cmd: 'setWindowSize',
              pid,
              width: viewport.width,
              height: viewport.height,
            })
            .catch((error: Error) => ({ error: error.message }));
          await log('window_size', {
            journey: journey.id,
            viewport,
            bundleId,
            result: resized,
          });
          await activate();
          await new Promise((resolve) => setTimeout(resolve, 300));
          await snapshot();
        },
        setTimeout(ms) {
          timeoutMs = ms;
        },
        location() {
          return lastURL;
        },
        inScope,
        async check(condition: Check) {
          const snap = await snapshot();
          if (condition.kind === 'path')
            return new RegExp(condition.pattern).test(`/${snap.window.title}`);
          // Rejected at suite load; keyboard focus is web-only.
          if (condition.kind === 'focused')
            throw new Error('focused checks are not supported on macOS');
          const { all, visible } = find(snap, condition.target);
          if (condition.kind === 'notVisible') return visible.length === 0;
          if (condition.kind === 'anyVisible') return visible.length > 0;
          if (condition.kind === 'anyRendered') return all.length > 0;
          if (visible.length !== 1) return false;
          if (condition.kind === 'visible') return true;
          return new RegExp(condition.pattern).test(textOf(snap, visible[0]!));
        },
        async observe(step, screenshot) {
          const snap = await snapshot();
          await session.screenshot(screenshot);
          const visible = visibleNodes(snap);
          const shown = snap.elements.filter((node) => visible.has(node.ref));
          const outline = snap.elements
            .map((node) => {
              const name = nameOf(node);
              const value = clean(node.value);
              return `${'  '.repeat(node.depth)}- ${roleOf(node)}${name ? ` "${name}"` : ''}${value && value !== name ? `: ${value}` : ''}`;
            })
            .join('\n');
          const text = shown
            .filter((node) => ['text', 'heading'].includes(roleOf(node)))
            .map(nameOf)
            .filter(Boolean)
            .join('\n');
          const controls = shown
            .filter(
              (node) =>
                !isChrome(node) &&
                (PRESSABLE.has(roleOf(node)) ||
                  roleOf(node) === 'option' ||
                  ['textbox', 'searchbox'].includes(roleOf(node))),
            )
            .slice(0, 100)
            .map((node) => ({
              role: roleOf(node),
              name: nameOf(node),
              value: clean(node.value) || undefined,
              disabled: node.enabled === false,
            }));
          const bars = snap.elements.filter(
            (node) => node.role === 'AXScrollBar' && node.value !== undefined,
          );
          const scroll = {
            x: 0,
            y: 0,
            containers: bars.map((bar) => ({
              index: bar.ref,
              x: 0,
              y: Number(bar.value),
            })),
          };
          return {
            step,
            url: lastURL,
            snapshot: outline.slice(0, 20000),
            screenshot,
            visibleViewport: {
              width: snap.window.frame.width,
              height: snap.window.frame.height,
              text: text.slice(0, 12000),
              textTruncated: snap.truncated || text.length > 12000,
              controls,
              canScrollUp: bars.some((bar) => Number(bar.value) > 0),
              canScrollDown: bars.some((bar) => Number(bar.value) < 1),
              scrollRegions: [],
            },
            fingerprint: createHash('sha256')
              .update(lastURL + outline)
              .digest('hex'),
            scroll,
            horizontalOverflow: 0,
          } satisfies Observation;
        },
        async candidates() {
          const snap = await snapshot();
          const visible = visibleNodes(snap);
          const out: Action[] = [];
          const names: string[] = [];
          const offer = (action: Action, guard: Guard, name?: string) => {
            guards.set(action, guard);
            out.push(action);
            if (name) names.push(name);
          };
          for (const interaction of journey.interactions) {
            const found = find(snap, interaction.target).visible;
            if (found.length !== 1 || found[0]!.enabled === false) continue;
            if (interaction.kind === 'select' || interaction.kind === 'press')
              continue;
            const node = found[0]!;
            // A configured click or check is performed with AXPress (rows are
            // selected instead). A control that offers no AXPress, such as a
            // view that reacts only to the mouse, would need a synthesized
            // click, so it is not offered.
            if (
              (interaction.kind === 'click' || interaction.kind === 'check') &&
              node.role !== 'AXRow' &&
              !node.actions.includes('AXPress')
            ) {
              await log('candidate_skipped', {
                journey: journey.id,
                phase: 'discovery',
                role: roleOf(node),
                name: nameOf(node),
                reason: 'no_accessibility_action',
              });
              continue;
            }
            offer(
              { ...interaction, id: `a${out.length}` },
              {
                kind: 'control',
                ref: node.ref,
                signature: signature(node),
                title: snap.window.title,
                select: node.role === 'AXRow',
              },
              nameOf(node),
            );
          }
          const counts = new Map<string, number>();
          const pressable = snap.elements.filter(
            (node) =>
              visible.has(node.ref) &&
              !isChrome(node) &&
              node.enabled !== false &&
              node.actions.includes('AXPress') &&
              PRESSABLE.has(roleOf(node)) &&
              nameOf(node),
          );
          for (const node of pressable) {
            const key = `${roleOf(node)}\u0000${nameOf(node)}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          for (const node of pressable) {
            const name = nameOf(node);
            const role = roleOf(node);
            if (blocked.some((pattern) => pattern.test(name))) {
              await log('candidate_skipped', {
                journey: journey.id,
                phase: 'discovery',
                role,
                name,
                reason: 'blocked',
              });
              continue;
            }
            const target: Target = node.identifier
              ? { by: 'testId', value: node.identifier }
              : { by: 'role', role: role as never, name };
            if (!node.identifier && counts.get(`${role}\u0000${name}`) !== 1)
              continue;
            if (
              out.some(
                (action) =>
                  'target' in action &&
                  JSON.stringify(action.target) === JSON.stringify(target),
              )
            )
              continue;
            offer(
              {
                kind: 'click',
                id: `a${out.length}`,
                target,
                description: `Press ${role} ${name}`,
              },
              {
                kind: 'control',
                ref: node.ref,
                signature: signature(node),
                title: snap.window.title,
              },
              name,
            );
          }
          // Rows of lists, tables and outlines: selected, not pressed. Rows that
          // are already selected or have no text are not offered.
          const rows = snap.elements.filter(
            (node) =>
              node.role === 'AXRow' &&
              visible.has(node.ref) &&
              node.enabled !== false &&
              node.selected === false &&
              nameOf(node),
          );
          const rowCounts = new Map<string, number>();
          for (const row of rows)
            rowCounts.set(nameOf(row), (rowCounts.get(nameOf(row)) ?? 0) + 1);
          for (const row of rows) {
            const name = nameOf(row);
            if (rowCounts.get(name) !== 1) continue;
            if (blocked.some((pattern) => pattern.test(name))) {
              await log('candidate_skipped', {
                journey: journey.id,
                phase: 'discovery',
                role: 'option',
                name,
                reason: 'blocked',
              });
              continue;
            }
            offer(
              {
                kind: 'click',
                id: `a${out.length}`,
                target: { by: 'role', role: 'option', name },
                description: `Select row ${name}`,
              },
              {
                kind: 'control',
                ref: row.ref,
                signature: signature(row),
                title: snap.window.title,
                select: true,
              },
              name,
            );
          }
          // Menu-bar commands (opt-in), read without opening menus. Whole menus
          // and risky commands are excluded; each path segment is checked.
          if (suite.menus) {
            const { items } = await helper.call<{
              items: { ref: number; path: string[]; enabled: boolean }[];
            }>({ cmd: 'menus', pid });
            const menuOnly = MENU_BLOCKED_CONTROLS.map(
              (pattern) => new RegExp(pattern, 'i'),
            );
            const menuBlocked = [...blocked, ...menuOnly];
            let menuCount = 0;
            for (const item of items) {
              const path = item.path.map((segment) => clean(segment));
              if (!item.enabled || EXCLUDED_MENUS.includes(path[0]!)) continue;
              const label = path.join(' › ');
              // The command itself is checked against every blocklist; parent
              // menu names ("Format", "Edit") only against the menu list.
              const leaf = path.at(-1)!;
              if (
                menuBlocked.some((pattern) => pattern.test(leaf)) ||
                path
                  .slice(0, -1)
                  .some((segment) =>
                    menuOnly.some((pattern) => pattern.test(segment)),
                  )
              ) {
                await log('candidate_skipped', {
                  journey: journey.id,
                  phase: 'discovery',
                  role: 'menuitem',
                  name: label,
                  reason: 'blocked',
                });
                continue;
              }
              if (menuCount++ >= 80) break;
              offer(
                {
                  kind: 'click',
                  id: `a${out.length}`,
                  target: { by: 'role', role: 'menuitem', name: label },
                  description: `Choose menu ${label}`,
                },
                {
                  kind: 'control',
                  ref: item.ref,
                  signature: '',
                  title: snap.window.title,
                  menu: item.path.at(-1)!,
                },
              );
            }
          }
          // Scroll areas that support page scrolling; the vertical scroll bar's
          // value (0..1) gives position for availability, staleness and loops.
          for (const area of snap.elements.filter(
            (node) =>
              node.role === 'AXScrollArea' &&
              visible.has(node.ref) &&
              node.actions.includes('AXScrollDownByPage'),
          )) {
            const bar = verticalBar(snap, area);
            const value = bar ? Number(bar.value) : null;
            const label = clean(area.description) || 'content';
            for (const direction of ['down', 'up'] as const) {
              if (
                value !== null &&
                (direction === 'down' ? value >= 0.999 : value <= 0.001)
              )
                continue;
              offer(
                {
                  kind: 'scroll',
                  id: `a${out.length}`,
                  description: `Scroll ${direction} in ${label} (r${area.ref})`,
                  direction,
                  region: `r${area.ref}`,
                  point: { x: 0, y: 0 },
                },
                {
                  kind: 'scroll',
                  ref: area.ref,
                  bar: bar?.ref ?? null,
                  value,
                  page: pageFraction(snap, area),
                  title: snap.window.title,
                },
              );
            }
          }
          offer(
            {
              kind: 'wait',
              id: `a${out.length}`,
              description: 'Wait briefly for loading to finish',
            },
            { kind: 'wait' },
          );
          offeredNames = names;
          return out;
        },
        offeredControls() {
          return offeredNames;
        },
        async repeatState(action) {
          const guard = guards.get(action);
          if (!guard || guard.kind === 'wait') return null;
          if (guard.kind === 'scroll') {
            const bar =
              guard.bar === null
                ? null
                : await helper.call<AXNode>({ cmd: 'inspect', ref: guard.bar });
            return JSON.stringify({
              title: guard.title,
              scroll: guard.ref,
              value: bar?.value ?? null,
            });
          }
          const current = await helper.call<AXNode & { valid: boolean }>({
            cmd: 'inspect',
            ref: guard.ref,
          });
          return JSON.stringify({
            title: guard.title,
            control: guard.signature,
            value: current.value ?? null,
          });
        },
        async execute(action, before) {
          const guard = guards.get(action);
          if (!guard)
            throw new Error(
              'Stale observation: action was not captured by this app',
            );
          if (!(await inScope()))
            throw new Error('Navigation left the journey scope');
          const frontBefore = await frontmost();
          if (lastURL !== before.url && action.kind !== 'wait')
            throw new Error(
              'Stale observation: window changed during selection',
            );
          if (guard.kind === 'wait') {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return;
          }
          if (guard.kind === 'scroll') {
            if (action.kind !== 'scroll') throw new Error('Stale observation');
            const area = await helper.call<AXNode & { valid: boolean }>({
              cmd: 'inspect',
              ref: guard.ref,
            });
            const bar =
              guard.bar === null
                ? null
                : await helper.call<AXNode & { valid: boolean }>({
                    cmd: 'inspect',
                    ref: guard.bar,
                  });
            if (
              !area.valid ||
              (bar && (!bar.valid || Number(bar.value) !== guard.value))
            )
              throw new Error(
                'Stale observation: scroll position changed during selection',
              );
            const page =
              action.direction === 'down'
                ? 'AXScrollDownByPage'
                : 'AXScrollUpByPage';
            const expected =
              guard.value === null
                ? null
                : Math.max(
                    0,
                    Math.min(
                      1,
                      guard.value +
                        (action.direction === 'down'
                          ? guard.page
                          : -guard.page),
                    ),
                  );
            const performed = await helper
              .call({ cmd: 'perform', ref: guard.ref, action: page })
              .then(() => true)
              .catch((caught: Error) => {
                if (guard.bar === null) throw caught;
                return false;
              });
            // SwiftUI advertises page scrolling, then fails at the top and jumps
            // back to the top from mid-list while reporting success. Verify the
            // scroll bar moved the requested way; otherwise set the position.
            if (guard.bar !== null && expected !== null) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              const after = performed
                ? Number(
                    (
                      await helper.call<AXNode>({
                        cmd: 'inspect',
                        ref: guard.bar,
                      })
                    ).value,
                  )
                : NaN;
              const moved =
                action.direction === 'down'
                  ? after > guard.value!
                  : after < guard.value!;
              if (!moved)
                await helper.call({
                  cmd: 'setScroll',
                  ref: guard.bar,
                  value: expected,
                });
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
            return;
          }
          const current = await helper.call<AXNode & { valid: boolean }>({
            cmd: 'inspect',
            ref: guard.ref,
          });
          const same =
            guard.menu !== undefined
              ? current.title === guard.menu
              : signature(current) === guard.signature;
          if (!current.valid || !same || current.enabled === false)
            throw new Error(
              'Stale observation: selected control changed during selection',
            );
          if (action.kind === 'fill')
            await helper.call({
              cmd: 'setValue',
              ref: guard.ref,
              value: action.value,
            });
          else if (action.kind === 'check') {
            const checked = current.value === '1';
            if (checked !== action.checked)
              await helper.call({ cmd: 'press', ref: guard.ref });
          } else if (guard.select) {
            await helper.call({ cmd: 'select', ref: guard.ref });
            const after = await helper.call<AXNode>({
              cmd: 'inspect',
              ref: guard.ref,
            });
            if (after.selected !== true)
              throw new Error('The row did not become selected');
          } else await helper.call({ cmd: 'press', ref: guard.ref });
          await new Promise((resolve) => setTimeout(resolve, 300));
          const frontAfter = await frontmost();
          if (frontAfter.pid !== frontBefore.pid && frontAfter.pid !== pid) {
            leftScope = true;
            await log('scope_left', {
              journey: journey.id,
              action: action.description,
              frontmost: frontAfter.bundleId,
            });
            throw new Error(
              `Navigation left the journey scope: ${frontAfter.bundleId} came to the front`,
            );
          }
          if (!(await inScope()))
            throw new Error('Navigation left the journey scope');
        },
        async screenshot(path) {
          let snap = last ?? (await snapshot());
          // The window can be missing from the window list briefly while the
          // window server creates or resizes it.
          for (let retry = 0; !snap.window.number && retry < 10; retry++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            snap = await snapshot();
          }
          if (!snap.window.number)
            throw new Error(
              'The application window could not be found for capture',
            );
          await run(
            'screencapture',
            ['-x', '-o', '-l', String(snap.window.number), path],
            { timeout: timeoutMs + 5000 },
          );
          // Retina captures are 2x; store them at window point size.
          await run(
            'sips',
            [
              '--resampleWidth',
              String(Math.round(snap.window.frame.width)),
              path,
            ],
            { timeout: timeoutMs + 5000 },
          );
        },
        async finish(trace) {
          // No Playwright trace for native apps: record the final accessibility tree.
          const path = trace.replace(/\.zip$/, '.json');
          await writeFile(path, JSON.stringify(last ?? {}, null, 2), {
            mode: 0o600,
          });
          return { video: null, trace: path };
        },
      };
      return session;
    },
    async close() {
      helper.close();
    },
  };
}
