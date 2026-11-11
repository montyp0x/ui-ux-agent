// In-page layout measurement. Self-contained for Playwright serialization:
// no imports at runtime, helpers are object methods (named inner functions get
// transpiler name helpers that do not exist in the page). The output is raw
// and is parsed against layoutAuditResultSchema by the caller.
import type {
  Box,
  LayoutDetectorResult,
  LayoutExempted,
  LayoutFinding,
  LayoutReviewCandidate,
  LayoutRule,
} from './layout.js';

export type DetectInput = {
  rules: LayoutRule[];
  tolerancePx: number;
  minCoveredFraction: number;
  minimum: number;
  spacingExemption: boolean;
  exceptions: {
    index: number;
    rule: LayoutRule;
    selector: string;
    reason: string;
  }[];
  // Resolved required controls; null checks every interactive control.
  required: { index: number; label: string; elements: Element[] }[] | null;
  limits: { findings: number; items: number; controls: number; text: number };
};

export type DetectOutput = {
  url: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  detectors: LayoutDetectorResult[];
  uses: Record<number, number>;
};

type Rect = { left: number; top: number; right: number; bottom: number };
type ClipItem = {
  element: Element;
  kind: 'text' | 'control';
  excerpt: string;
  rects: Rect[];
};
type ClipEntry = ClipItem & {
  cut: Record<'left' | 'right' | 'top' | 'bottom', number>;
};
type ClipGroup = {
  container: Element;
  style: CSSStyleDeclaration;
  clip: Rect;
  items: ClipEntry[];
  exempt: Map<number, ClipEntry[]>;
  candidates: number;
};

export function detectLayout(input: DetectInput): DetectOutput {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const uses: Record<number, number> = {};
  const renderedCache = new Map<Element, boolean>();
  const TARGETS =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="option"], [role="slider"]';
  const g = {
    parent(element: Element): Element | null {
      return (
        element.parentElement ??
        (element.getRootNode() instanceof ShadowRoot
          ? (element.getRootNode() as ShadowRoot).host
          : null)
      );
    },
    contains(ancestor: Element, descendant: Element): boolean {
      for (let node: Element | null = descendant; node; node = g.parent(node))
        if (node === ancestor) return true;
      return false;
    },
    roots(): ParentNode[] {
      const roots: ParentNode[] = [document];
      for (let index = 0; index < roots.length; index++)
        for (const element of Array.from(roots[index]!.querySelectorAll('*')))
          if (element.shadowRoot) roots.push(element.shadowRoot);
      return roots;
    },
    all(selector: string): Element[] {
      return g
        .roots()
        .flatMap((root) => Array.from(root.querySelectorAll(selector)));
    },
    // Matches the element or an ancestor, crossing open shadow boundaries.
    closest(element: Element, selector: string): Element | null {
      for (let node: Element | null = element; node;) {
        const match = node.closest(selector);
        if (match) return match;
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : null;
      }
      return null;
    },
    rendered(element: Element): boolean {
      const cached = renderedCache.get(element);
      if (cached !== undefined) return cached;
      const style = getComputedStyle(element);
      let value =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        Number(style.opacity) !== 0;
      const parent = g.parent(element);
      if (value && parent) value = g.rendered(parent);
      renderedCache.set(element, value);
      return value;
    },
    hit(x: number, y: number): Element | null {
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      return hit;
    },
    selector(element: Element): string {
      const root = element.getRootNode() as Document | ShadowRoot;
      const parts: string[] = [];
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        if (
          node.id &&
          root.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1
        ) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const testId = node.getAttribute('data-testid');
        if (
          testId &&
          root.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`)
            .length === 1
        ) {
          parts.unshift(`[data-testid="${CSS.escape(testId)}"]`);
          break;
        }
        const tag = node.localName;
        if (tag === 'html' || tag === 'body') {
          parts.unshift(tag);
          break;
        }
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter(
              (sibling) => sibling.localName === tag,
            )
          : [node];
        parts.unshift(
          siblings.length > 1
            ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`
            : tag,
        );
      }
      const own = parts.join(' > ');
      // Playwright-style chaining through open shadow roots.
      return root instanceof ShadowRoot
        ? `${g.selector(root.host)} >> ${own}`
        : own;
    },
    round(value: number): number {
      return Math.round(value * 10) / 10;
    },
    box(rect: Rect): Box {
      return {
        x: g.round(rect.left + window.scrollX),
        y: g.round(rect.top + window.scrollY),
        width: g.round(rect.right - rect.left),
        height: g.round(rect.bottom - rect.top),
      };
    },
    union(rects: Rect[]): Rect {
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      };
    },
    name(element: Element): string {
      return (
        element.getAttribute('aria-label') ??
        element.getAttribute('alt') ??
        element.getAttribute('title') ??
        (element as HTMLElement).innerText ??
        element.textContent ??
        ''
      )
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80);
    },
    // Visible part of a rect after ancestor overflow clipping (and the
    // viewport when asked), the same rule projectViewport applies.
    visibleRect(element: Element, rect: Rect, viewport: boolean): Rect | null {
      let { left, top, right, bottom } = rect;
      if (viewport) {
        left = Math.max(0, left);
        top = Math.max(0, top);
        right = Math.min(width, right);
        bottom = Math.min(height, bottom);
      }
      for (let node = g.parent(element); node; node = g.parent(node)) {
        if (node === document.documentElement || node === document.body) break;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, box.left + node.clientLeft);
          right = Math.min(
            right,
            box.left + node.clientLeft + node.clientWidth,
          );
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, box.top + node.clientTop);
          bottom = Math.min(
            bottom,
            box.top + node.clientTop + node.clientHeight,
          );
        }
      }
      return right - left > 0.5 && bottom - top > 0.5
        ? { left, top, right, bottom }
        : null;
    },
    exception(
      rule: LayoutRule,
      element: Element,
    ): DetectInput['exceptions'][number] | null {
      for (const exception of input.exceptions)
        if (exception.rule === rule && g.closest(element, exception.selector))
          return exception;
      return null;
    },
    use(exception: DetectInput['exceptions'][number]) {
      uses[exception.index] = (uses[exception.index] ?? 0) + 1;
    },
    targets(): Element[] {
      return g
        .all(TARGETS)
        .filter(
          (element) =>
            !(
              element.parentElement && g.closest(element.parentElement, TARGETS)
            ),
        );
    },
    // The sr-only pattern: a 1px box or a zero clip rect. Such content is
    // meant for assistive technology, not pointer users.
    visuallyHidden(element: Element, rect: DOMRect): boolean {
      return (
        rect.width <= 1 ||
        rect.height <= 1 ||
        /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(
          getComputedStyle(element).clip,
        )
      );
    },
    disabled(element: Element): boolean {
      return (
        element.matches(':disabled') ||
        element.getAttribute('aria-disabled') === 'true'
      );
    },
    empty(rule: LayoutRule): LayoutDetectorResult {
      return {
        rule,
        status: 'clean',
        checked: 0,
        skipped: {},
        findings: [],
        exempted: [],
        reviewCandidates: [],
        incomplete: [],
        truncated: false,
        error: null,
      };
    },
    skip(result: LayoutDetectorResult, reason: string) {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    },
    finding(result: LayoutDetectorResult, finding: LayoutFinding) {
      if (result.findings.length >= input.limits.findings) {
        result.truncated = true;
        return;
      }
      result.findings.push(finding);
    },
    exempt(result: LayoutDetectorResult, entry: LayoutExempted) {
      if (result.exempted.length >= input.limits.findings) {
        result.truncated = true;
        return;
      }
      result.exempted.push(entry);
    },
    candidate(result: LayoutDetectorResult, entry: LayoutReviewCandidate) {
      if (result.reviewCandidates.length >= input.limits.findings) {
        result.truncated = true;
        return;
      }
      result.reviewCandidates.push(entry);
    },
    // Each detector fails alone; an error is reported, never a clean result.
    run(rule: LayoutRule, detector: (result: LayoutDetectorResult) => void) {
      const result = g.empty(rule);
      try {
        for (const exception of input.exceptions)
          if (exception.rule === rule)
            try {
              document.querySelector(exception.selector);
            } catch {
              throw new Error(
                `Invalid exception selector #${exception.index}: ${exception.selector}`,
              );
            }
        detector(result);
      } catch (caught) {
        result.error =
          caught instanceof Error
            ? `${caught.name}: ${caught.message}`.slice(0, 500)
            : String(caught).slice(0, 500);
      }
      result.status =
        result.error !== null
          ? 'error'
          : result.findings.length
            ? 'findings'
            : result.incomplete.length
              ? 'incomplete'
              : 'clean';
      return result;
    },

    clippingFinding(group: ClipGroup, list: ClipEntry[]): LayoutFinding {
      const maxCut = Math.max(
        ...list.map((item) =>
          Math.max(
            item.cut.left,
            item.cut.right,
            item.cut.top,
            item.cut.bottom,
          ),
        ),
      );
      const edges = new Set(
        list.flatMap((item) =>
          (['left', 'right', 'top', 'bottom'] as const).filter(
            (edge) => item.cut[edge] > input.tolerancePx,
          ),
        ),
      );
      return {
        rule: 'clipping',
        selector: g.selector(group.container),
        box: g.box(group.container.getBoundingClientRect()),
        clipBox: g.box(group.clip),
        overflowX: group.style.overflowX,
        overflowY: group.style.overflowY,
        items: list.slice(0, input.limits.items).map((item) => {
          const total = item.rects.reduce(
            (sum, rect) =>
              sum + (rect.right - rect.left) * (rect.bottom - rect.top),
            0,
          );
          const visible = item.rects.reduce((sum, rect) => {
            const w =
              Math.min(rect.right, group.clip.right) -
              Math.max(rect.left, group.clip.left);
            const h =
              Math.min(rect.bottom, group.clip.bottom) -
              Math.max(rect.top, group.clip.top);
            return sum + Math.max(0, w) * Math.max(0, h);
          }, 0);
          return {
            selector: g.selector(item.element),
            kind: item.kind,
            excerpt: item.excerpt,
            box: g.box(g.union(item.rects)),
            cut: item.cut,
            visibleFraction: total
              ? Math.min(1, Math.round((visible / total) * 100) / 100)
              : 0,
          };
        }),
        itemsTotal: list.length,
        maxCutPx: g.round(maxCut),
        description: `${list.length} ${list.length === 1 ? 'item' : 'items'} cut off by up to ${g.round(maxCut)}px at the ${Array.from(edges).join('/')} edge of an overflow ${group.style.overflowX}/${group.style.overflowY} container`,
      };
    },

    // The most-hit covering element and its nearest positioned ancestor (the
    // covering layer, e.g. a fixed banner).
    cover(covers: Map<Element, number>): [Element, Element] {
      const cover = Array.from(covers.entries()).sort(
        (a, b) => b[1] - a[1],
      )[0]![0];
      for (let node: Element | null = cover; node; node = g.parent(node))
        if (getComputedStyle(node).position !== 'static') return [cover, node];
      return [cover, cover];
    },
    layer(covers: Map<Element, number>): string {
      return g.selector(g.cover(covers)[1]);
    },
    occlusionFinding(
      subject: {
        element: Element;
        rect: DOMRect;
        required: boolean;
        samples: number;
      },
      covers: Map<Element, number>,
      count: number,
      center: boolean,
    ): LayoutFinding {
      const [cover, layer] = g.cover(covers);
      const name = g.name(subject.element);
      return {
        rule: 'occlusion',
        selector: g.selector(subject.element),
        name,
        box: g.box(subject.rect),
        required: subject.required,
        cover: {
          selector: g.selector(cover),
          layer: g.selector(layer),
          box: g.box(layer.getBoundingClientRect()),
        },
        samples: subject.samples,
        covered: count,
        coveredFraction: Math.round((count / subject.samples) * 100) / 100,
        centerCovered: center,
        description: `${subject.required ? 'Required control' : 'Control'} "${name.slice(0, 40)}" is covered at ${count} of ${subject.samples} hit-test points${center ? ', including its centre,' : ''} by ${g.selector(layer)} after scrolling it into view`,
      };
    },
    builtIn(
      result: LayoutDetectorResult,
      finding: LayoutFinding,
      kind: 'inline' | 'spacing' | 'equivalent-label',
      detail: string,
    ) {
      g.exempt(result, {
        rule: finding.rule,
        selector: finding.selector,
        exemption: { kind, detail },
        measured: finding,
      });
    },
    // ---- clipping: text or controls cut off by an overflow hidden/clip box ----
    clipping(result: LayoutDetectorResult) {
      const items: ClipItem[] = [];
      let scanned = 0;
      for (const root of g.roots()) {
        const walker = document.createTreeWalker(
          root instanceof Document ? root.body : root,
          NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = (node.textContent ?? '').trim();
          const element = node.parentElement;
          if (!text || !element) continue;
          if (element.closest('script, style, noscript, template, title'))
            continue;
          if (++scanned > input.limits.text) {
            result.incomplete.push(
              `Text scan limit (${input.limits.text} runs) reached`,
            );
            break;
          }
          if (!g.rendered(element)) {
            g.skip(result, 'not-rendered');
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          );
          if (rects.length)
            items.push({
              element,
              kind: 'text',
              excerpt: text.replace(/\s+/g, ' ').slice(0, 80),
              rects,
            });
        }
      }
      for (const element of g.targets().slice(0, input.limits.controls)) {
        if (!g.rendered(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0)
          items.push({
            element,
            kind: 'control',
            excerpt: g.name(element),
            rects: [rect],
          });
      }
      const groups = new Map<Element, ClipGroup>();
      for (const item of items) {
        result.checked++;
        // Walk the clipping chain. Absolutely positioned boxes skip ancestors
        // below their containing block; fixed boxes escape to the viewport.
        let escape: 'absolute' | 'fixed' | null = null;
        let start: Element | null = item.element;
        if (item.kind === 'control') {
          const position = getComputedStyle(item.element).position;
          escape =
            position === 'fixed'
              ? 'fixed'
              : position === 'absolute'
                ? 'absolute'
                : null;
          start = g.parent(item.element);
        }
        let openX = true;
        let openY = true;
        for (let node = start; node; node = g.parent(node)) {
          if (node === document.documentElement || node === document.body)
            break;
          const style = getComputedStyle(node);
          if (escape) {
            const containing =
              escape === 'fixed'
                ? style.transform !== 'none' ||
                  style.filter !== 'none' ||
                  /paint|layout|strict|content/.test(style.contain)
                : style.position !== 'static' || style.transform !== 'none';
            if (!containing) continue;
            escape = null;
          }
          const hiddenX = openX && /hidden|clip/.test(style.overflowX);
          const hiddenY = openY && /hidden|clip/.test(style.overflowY);
          if (hiddenX || hiddenY) {
            const box = node.getBoundingClientRect();
            // Visually hidden (sr-only) and collapsed containers hide their
            // content on purpose.
            if (box.width <= 1 || box.height <= 1) {
              g.skip(result, 'collapsed-container');
              break;
            }
            const clip: Rect = {
              left: box.left + node.clientLeft,
              top: box.top + node.clientTop,
              right: box.left + node.clientLeft + node.clientWidth,
              bottom: box.top + node.clientTop + node.clientHeight,
            };
            const cut = { left: 0, right: 0, top: 0, bottom: 0 };
            for (const rect of item.rects) {
              if (hiddenX) {
                cut.left = Math.max(cut.left, clip.left - rect.left);
                cut.right = Math.max(cut.right, rect.right - clip.right);
              }
              if (hiddenY) {
                cut.top = Math.max(cut.top, clip.top - rect.top);
                cut.bottom = Math.max(cut.bottom, rect.bottom - clip.bottom);
              }
            }
            const cutX = Math.max(cut.left, cut.right) > input.tolerancePx;
            const cutY = Math.max(cut.top, cut.bottom) > input.tolerancePx;
            if (cutX || cutY) {
              const group: ClipGroup = groups.get(node) ?? {
                container: node,
                style,
                clip,
                items: [],
                exempt: new Map(),
                candidates: 0,
              };
              groups.set(node, group);
              const lineClamp = style.getPropertyValue('-webkit-line-clamp');
              // Declared truncation is the author's intent: review only.
              if (
                (cutX && !cutY && style.textOverflow === 'ellipsis') ||
                (cutY && !cutX && lineClamp && lineClamp !== 'none')
              ) {
                if (!group.candidates++)
                  g.candidate(result, {
                    rule: 'clipping',
                    kind: cutX ? 'truncation-ellipsis' : 'line-clamp',
                    selector: g.selector(node),
                    box: g.box(box),
                    detail: `${cutX ? 'text-overflow: ellipsis' : '-webkit-line-clamp'} hides ${g.round(Math.max(cut.left, cut.right, cut.top, cut.bottom))}px of "${item.excerpt.slice(0, 40)}"`,
                  });
                break;
              }
              const entry = {
                ...item,
                cut: {
                  left: g.round(Math.max(0, cut.left)),
                  right: g.round(Math.max(0, cut.right)),
                  top: g.round(Math.max(0, cut.top)),
                  bottom: g.round(Math.max(0, cut.bottom)),
                },
              };
              const exception =
                g.exception('clipping', item.element) ??
                g.exception('clipping', node);
              if (exception) {
                g.use(exception);
                const list = group.exempt.get(exception.index) ?? [];
                list.push(entry);
                group.exempt.set(exception.index, list);
              } else group.items.push(entry);
              break;
            }
          }
          if (/auto|scroll/.test(style.overflowX)) openX = false;
          if (/auto|scroll/.test(style.overflowY)) openY = false;
          if (hiddenX) openX = false;
          if (hiddenY) openY = false;
          if (!openX && !openY) break;
          if (style.position === 'fixed') escape = 'fixed';
          else if (style.position === 'absolute') escape = 'absolute';
        }
      }
      for (const group of groups.values()) {
        if (group.items.length)
          g.finding(result, g.clippingFinding(group, group.items));
        for (const [index, list] of group.exempt) {
          const exception = input.exceptions.find(
            (entry) => entry.index === index,
          )!;
          g.exempt(result, {
            rule: 'clipping',
            selector: g.selector(group.container),
            exemption: {
              kind: 'exception',
              index,
              selector: exception.selector,
              reason: exception.reason,
              matchedOn: list.every((item) =>
                g.closest(item.element, exception.selector),
              )
                ? 'subject'
                : 'container',
            },
            measured: g.clippingFinding(group, list),
          });
        }
      }
    },

    // ---- occlusion: a control another element covers where it is hit ----
    occlusion(result: LayoutDetectorResult) {
      const modal = g
        .all('dialog:modal, [role="dialog"][aria-modal="true"]')
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && g.rendered(element);
        })
        .at(-1);
      const controls: { element: Element; required: boolean }[] = [];
      if (input.required) {
        for (const entry of input.required) {
          const rendered = entry.elements.filter((element) =>
            g.rendered(element),
          );
          if (!entry.elements.length)
            result.incomplete.push(
              `Required control #${entry.index} (${entry.label}) was not found`,
            );
          else if (!rendered.length)
            result.incomplete.push(
              `Required control #${entry.index} (${entry.label}) is not rendered`,
            );
          for (const element of rendered)
            controls.push({ element, required: true });
        }
      } else
        for (const element of g.targets().slice(0, input.limits.controls))
          controls.push({ element, required: false });
      for (const { element, required } of controls) {
        if (!g.rendered(element)) {
          g.skip(result, 'not-rendered');
          continue;
        }
        if (g.disabled(element)) {
          g.skip(result, 'disabled');
          continue;
        }
        if (modal && !g.contains(modal, element)) {
          g.skip(result, 'behind-modal');
          continue;
        }
        if (g.visuallyHidden(element, element.getBoundingClientRect())) {
          g.skip(result, 'visually-hidden');
          continue;
        }
        // Bring the control into view the way a user would, measure, then
        // restore every scroll position the move changed.
        const scrolled: [Element, number, number][] = [];
        for (let node = g.parent(element); node; node = g.parent(node))
          scrolled.push([node, node.scrollLeft, node.scrollTop]);
        const scroller = document.scrollingElement;
        if (scroller && !scrolled.some(([node]) => node === scroller))
          scrolled.push([scroller, scroller.scrollLeft, scroller.scrollTop]);
        try {
          element.scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'instant',
          });
          const rect = element.getBoundingClientRect();
          const visible = g.visibleRect(element, rect, true);
          if (!visible) {
            g.skip(result, 'not-visible');
            if (required)
              result.incomplete.push(
                `Required control ${g.selector(element)} is not visible after scrolling`,
              );
            continue;
          }
          result.checked++;
          const labels = Array.from((element as HTMLInputElement).labels ?? []);
          const fractions = [1 / 6, 1 / 2, 5 / 6];
          let covered = 0;
          let exemptCovered = 0;
          let centerCovered = false;
          let centerExempt = false;
          let usedException: DetectInput['exceptions'][number] | null = null;
          let matchedOn: 'subject' | 'cover' = 'cover';
          const covers = new Map<Element, number>();
          const exemptCovers = new Map<Element, number>();
          const subjectException = g.exception('occlusion', element);
          for (const fy of fractions)
            for (const fx of fractions) {
              const x = visible.left + (visible.right - visible.left) * fx;
              const y = visible.top + (visible.bottom - visible.top) * fy;
              const hit = g.hit(x, y);
              if (
                !hit ||
                g.contains(element, hit) ||
                g.contains(hit, element) ||
                labels.some((label) => g.contains(label, hit))
              )
                continue;
              const center = fx === 1 / 2 && fy === 1 / 2;
              const exception =
                subjectException ?? g.exception('occlusion', hit);
              if (exception) {
                usedException = exception;
                matchedOn = subjectException ? 'subject' : 'cover';
                exemptCovered++;
                if (center) centerExempt = true;
                exemptCovers.set(hit, (exemptCovers.get(hit) ?? 0) + 1);
              } else {
                covered++;
                if (center) centerCovered = true;
                covers.set(hit, (covers.get(hit) ?? 0) + 1);
              }
            }
          const samples = fractions.length ** 2;
          if (!covered && !exemptCovered) continue;
          const subject = { element, rect, required, samples };
          if (centerCovered || covered / samples >= input.minCoveredFraction)
            g.finding(
              result,
              g.occlusionFinding(subject, covers, covered, centerCovered),
            );
          else if (
            usedException &&
            (centerCovered ||
              centerExempt ||
              (covered + exemptCovered) / samples >= input.minCoveredFraction)
          ) {
            g.use(usedException);
            g.exempt(result, {
              rule: 'occlusion',
              selector: g.selector(element),
              exemption: {
                kind: 'exception',
                index: usedException.index,
                selector: usedException.selector,
                reason: usedException.reason,
                matchedOn,
              },
              measured: g.occlusionFinding(
                subject,
                new Map([...exemptCovers, ...covers]),
                covered + exemptCovered,
                centerCovered || centerExempt,
              ),
            });
          } else if (covered)
            g.candidate(result, {
              rule: 'occlusion',
              kind: 'partial-occlusion',
              selector: g.selector(element),
              box: g.box(rect),
              detail: `${covered} of ${samples} hit-test points covered by ${g.layer(covers)}, below the ${input.minCoveredFraction} threshold`,
            });
        } finally {
          for (const [node, left, top] of scrolled) {
            node.scrollLeft = left;
            node.scrollTop = top;
          }
        }
      }
    },

    // ---- target-size: pointer targets below the configured minimum ----
    targetSize(result: LayoutDetectorResult) {
      const minimum = input.minimum;
      const measured: { element: Element; rect: DOMRect }[] = [];
      for (const element of g.targets().slice(0, input.limits.controls)) {
        if (!g.rendered(element)) {
          g.skip(result, 'not-rendered');
          continue;
        }
        if (g.disabled(element)) {
          g.skip(result, 'disabled');
          continue;
        }
        const rect = element.getBoundingClientRect();
        // Visually hidden (sr-only) or pushed out of the document.
        if (g.visuallyHidden(element, rect)) {
          g.skip(result, 'visually-hidden');
          continue;
        }
        if (
          rect.right + window.scrollX <= 0 ||
          rect.bottom + window.scrollY <= 0 ||
          !g.visibleRect(element, rect, false)
        ) {
          g.skip(result, 'not-rendered');
          continue;
        }
        measured.push({ element, rect });
      }
      if (g.targets().length > input.limits.controls)
        result.incomplete.push(
          `Control limit (${input.limits.controls}) reached`,
        );
      const undersized = measured.filter(
        ({ rect }) =>
          rect.width < minimum - 0.01 || rect.height < minimum - 0.01,
      );
      for (const { element, rect } of measured) {
        result.checked++;
        if (!undersized.some((entry) => entry.element === element)) continue;
        const finding: LayoutFinding = {
          rule: 'target-size',
          selector: g.selector(element),
          name: g.name(element),
          box: g.box(rect),
          width: g.round(rect.width),
          height: g.round(rect.height),
          minimum,
          description: `Target "${g.name(element).slice(0, 40)}" is ${g.round(rect.width)}x${g.round(rect.height)} CSS px, below the ${minimum}x${minimum} minimum`,
        };
        // Inline: a link in a sentence, sized by the surrounding line height.
        if (getComputedStyle(element).display === 'inline') {
          let block: Element | null = g.parent(element);
          while (block && getComputedStyle(block).display === 'inline')
            block = g.parent(block);
          const walker = block
            ? document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
            : null;
          let prose = false;
          for (let node = walker?.nextNode(); node; node = walker!.nextNode())
            if (
              node.textContent?.trim() &&
              node.parentElement &&
              !g.closest(node.parentElement, TARGETS)
            ) {
              prose = true;
              break;
            }
          if (prose) {
            g.builtIn(
              result,
              finding,
              'inline',
              'Inline target within a sentence of text',
            );
            continue;
          }
        }
        // A native checkbox or radio whose label is a large enough target.
        const labels = Array.from((element as HTMLInputElement).labels ?? []);
        if (
          element.matches('input[type="checkbox"], input[type="radio"]') &&
          labels.some((label) => {
            const box = g.union([rect, ...Array.from(label.getClientRects())]);
            return (
              box.right - box.left >= minimum && box.bottom - box.top >= minimum
            );
          })
        ) {
          g.builtIn(
            result,
            finding,
            'equivalent-label',
            'Its label extends the target',
          );
          continue;
        }
        if (input.spacingExemption) {
          const cx = (rect.left + rect.right) / 2;
          const cy = (rect.top + rect.bottom) / 2;
          const radius = minimum / 2;
          let clear = true;
          let nearest = Infinity;
          for (const other of measured) {
            if (other.element === element) continue;
            const dx = Math.max(other.rect.left - cx, 0, cx - other.rect.right);
            const dy = Math.max(other.rect.top - cy, 0, cy - other.rect.bottom);
            const toRect = Math.hypot(dx, dy);
            nearest = Math.min(nearest, toRect);
            if (toRect < radius) clear = false;
            if (
              undersized.some((entry) => entry.element === other.element) &&
              Math.hypot(
                (other.rect.left + other.rect.right) / 2 - cx,
                (other.rect.top + other.rect.bottom) / 2 - cy,
              ) < minimum
            )
              clear = false;
            if (!clear) break;
          }
          if (clear) {
            g.builtIn(
              result,
              finding,
              'spacing',
              `A ${minimum}px circle on its centre touches no other target (nearest ${Number.isFinite(nearest) ? g.round(nearest) : 'none'}px)`,
            );
            continue;
          }
        }
        const exception = g.exception('target-size', element);
        if (exception) {
          g.use(exception);
          g.exempt(result, {
            rule: 'target-size',
            selector: finding.selector,
            exemption: {
              kind: 'exception',
              index: exception.index,
              selector: exception.selector,
              reason: exception.reason,
              matchedOn: 'subject',
            },
            measured: finding,
          });
          continue;
        }
        g.finding(result, finding);
      }
    },
  };
  const detectors: LayoutDetectorResult[] = [];
  for (const rule of input.rules)
    detectors.push(
      g.run(rule, (result) =>
        rule === 'clipping'
          ? g.clipping(result)
          : rule === 'occlusion'
            ? g.occlusion(result)
            : g.targetSize(result),
      ),
    );
  return {
    url: location.href,
    viewport: { width, height, devicePixelRatio: window.devicePixelRatio },
    detectors,
    uses,
  };
}
