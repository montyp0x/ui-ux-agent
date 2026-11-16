// In-page measurement for the design.tokens audit. Self-contained for
// Playwright serialization: no imports at runtime, helpers are object methods
// (named inner functions get transpiler name helpers that do not exist in the
// page). It only reads computed styles; it never changes the page. The output
// is raw and is parsed against designMeasurementSchema by the caller.
import type {
  DesignMeasurement,
  DesignRule,
  DesignSample,
} from './design-tokens.js';

export type DesignDetectInput = {
  include: string[];
  exclude: string[];
  rules: DesignRule[];
  // Exception selectors, by configured index.
  exceptions: string[];
  maxElements: number;
};

export function detectDesign(input: DesignDetectInput): DesignMeasurement {
  const SKIP = new Set([
    'script',
    'style',
    'template',
    'head',
    'meta',
    'link',
    'title',
    'noscript',
    'br',
    'wbr',
    'svg',
    'iframe',
    'frame',
    'object',
    'embed',
  ]);
  const TEXT_CONTROLS = new Set(['input', 'textarea', 'select', 'button']);
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const rules = new Set(input.rules);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const typedOM =
    typeof (Element.prototype as { computedStyleMap?: unknown })
      .computedStyleMap === 'function' &&
    typeof CSSUnitValue !== 'undefined' &&
    typeof CSSKeywordValue !== 'undefined' &&
    typeof CSSNumericValue !== 'undefined';
  const nodes: DesignMeasurement['nodes'] = [];
  const samples: DesignSample[] = [];
  const skipped = { relative: 0, auto: 0, unreadable: 0 };
  const g = {
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
    closest(element: Element, selector: string): Element | null {
      for (let node: Element | null = element; node;) {
        const match = node.closest(selector);
        if (match) return match;
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : null;
      }
      return null;
    },
    children(element: Element): Element[] {
      const list = Array.from(element.children);
      if (element.shadowRoot)
        list.push(...Array.from(element.shadowRoot.children));
      return list;
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
      return root instanceof ShadowRoot
        ? `${g.selector(root.host)} >> ${own}`
        : own;
    },
    // The tag with its id or first classes: names the element without page text.
    describe(element: Element): string {
      const tag = element.localName;
      if (element.id) return `${tag}#${element.id}`.slice(0, 120);
      const classes = Array.from(element.classList).slice(0, 2);
      return (classes.length ? `${tag}.${classes.join('.')}` : tag).slice(
        0,
        120,
      );
    },
    hasText(element: Element): boolean {
      if (TEXT_CONTROLS.has(element.localName)) return true;
      for (const child of Array.from(element.childNodes))
        if (
          child.nodeType === Node.TEXT_NODE &&
          (child.textContent ?? '').trim()
        )
          return true;
      return false;
    },
    rgba(value: string): [number, number, number, number] | null {
      const legacy = /^rgba?\(([^)]*)\)$/.exec(value.trim());
      if (legacy) {
        const parts = legacy[1]!
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        if (parts.length >= 3 && parts.every((part) => Number.isFinite(part)))
          return [
            parts[0]!,
            parts[1]!,
            parts[2]!,
            parts.length > 3 ? parts[3]! : 1,
          ];
      }
      // Other colour syntaxes (color(), lab(), oklch() ...) converted to
      // sRGB by drawing one pixel on a detached canvas.
      if (!context) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, gr, b, a] = Array.from(context.getImageData(0, 0, 1, 1).data);
      return [r!, gr!, b!, a! / 255];
    },
    // One sample per element, rule, property and value.
    add(
      own: DesignSample[],
      seen: Set<string>,
      node: number,
      rule: DesignRule,
      property: string,
      value: string,
      px: number | null,
      rgba: [number, number, number, number] | null,
    ): void {
      const sample: DesignSample = { node, rule, property, value, px, rgba };
      const key = `${sample.rule}|${sample.property}|${sample.value}|${sample.px}`;
      if (seen.has(key)) return;
      seen.add(key);
      own.push(sample);
    },
    // A typed length in px; null (counted) for auto, relative and unreadable
    // values. Some engines (WebKit) return lengths as untyped CSSStyleValue
    // objects: their text is parsed with CSSNumericValue.parse; a px length
    // is measured, a percentage or calc() is relative (as when typed), and
    // anything else (unparseable text, em and other units) is unreadable,
    // never guessed.
    typed(map: StylePropertyMapReadOnly, property: string): number | null {
      const value = map.get(property);
      if (value instanceof CSSKeywordValue) {
        if (value.value === 'auto') skipped.auto++;
        return null;
      }
      if (value instanceof CSSUnitValue && value.unit === 'px')
        return value.value;
      if (value instanceof CSSUnitValue && value.unit === 'number') return null;
      if (value instanceof CSSNumericValue) {
        skipped.relative++;
        return null;
      }
      if (value !== undefined) {
        let parsed: CSSNumericValue | null = null;
        try {
          parsed = CSSNumericValue.parse(String(value));
        } catch {
          parsed = null;
        }
        if (parsed instanceof CSSUnitValue && parsed.unit === 'px')
          return parsed.value;
        // A percentage or a calc() is relative, as when it comes typed:
        // counted, not compared.
        if (
          (parsed instanceof CSSUnitValue && parsed.unit === 'percent') ||
          (typeof CSSMathValue !== 'undefined' &&
            parsed instanceof CSSMathValue)
        ) {
          skipped.relative++;
          return null;
        }
      }
      skipped.unreadable++;
      return null;
    },
  };
  for (const selector of input.exclude) document.querySelectorAll(selector);
  for (const selector of input.exceptions) document.querySelectorAll(selector);
  let roots: Element[];
  if (input.include.length) {
    roots = [];
    for (const selector of input.include) {
      const found = g.all(selector);
      if (!found.length)
        throw new Error(
          `design.tokens scope selector "${selector}" matched nothing`,
        );
      roots.push(...found);
    }
  } else roots = document.body ? [document.body] : [];
  const visited = new Set<Element>();
  let elements = 0;
  let truncated = false;
  const stack = [...roots].reverse();
  while (stack.length) {
    const element = stack.pop()!;
    if (visited.has(element)) continue;
    visited.add(element);
    if (SKIP.has(element.localName)) continue;
    if (input.exclude.some((selector) => g.closest(element, selector)))
      continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || Number(style.opacity) === 0) continue;
    const children = g.children(element);
    for (let index = children.length - 1; index >= 0; index--)
      stack.push(children[index]!);
    if (
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.display === 'contents' ||
      !element.getClientRects().length
    )
      continue;
    if (elements >= input.maxElements) {
      truncated = true;
      break;
    }
    elements++;
    const node = nodes.length;
    const own: DesignSample[] = [];
    const seen = new Set<string>();
    const text = g.hasText(element);
    if (rules.has('color')) {
      if (text) {
        const rgba = g.rgba(style.color);
        if (rgba && rgba[3] > 0)
          g.add(own, seen, node, 'color', 'color', style.color, null, rgba);
      }
      const background = g.rgba(style.backgroundColor);
      if (background && background[3] > 0)
        g.add(
          own,
          seen,
          node,
          'color',
          'background-color',
          style.backgroundColor,
          null,
          background,
        );
      for (const side of SIDES) {
        const width = parseFloat(
          style.getPropertyValue(`border-${side}-width`),
        );
        const kind = style.getPropertyValue(`border-${side}-style`);
        if (!(width > 0) || kind === 'none' || kind === 'hidden') continue;
        const value = style.getPropertyValue(`border-${side}-color`);
        const rgba = g.rgba(value);
        if (rgba && rgba[3] > 0)
          g.add(own, seen, node, 'color', 'border-color', value, null, rgba);
      }
    }
    if (text && rules.has('font-family'))
      g.add(
        own,
        seen,
        node,
        'font-family',
        'font-family',
        style.fontFamily,
        null,
        null,
      );
    if (text && rules.has('font-size')) {
      const size = parseFloat(style.fontSize);
      if (Number.isFinite(size))
        g.add(
          own,
          seen,
          node,
          'font-size',
          'font-size',
          style.fontSize,
          size,
          null,
        );
    }
    if (rules.has('spacing') && typedOM) {
      const map = element.computedStyleMap();
      for (const group of ['margin', 'padding'])
        for (const side of SIDES) {
          const value = g.typed(map, `${group}-${side}`);
          if (value)
            g.add(own, seen, node, 'spacing', group, `${value}px`, value, null);
        }
      if (/flex|grid/.test(style.display))
        for (const property of ['row-gap', 'column-gap']) {
          const value = g.typed(map, property);
          if (value)
            g.add(own, seen, node, 'spacing', 'gap', `${value}px`, value, null);
        }
    }
    if (rules.has('radius'))
      for (const corner of CORNERS) {
        const value = style.getPropertyValue(`border-${corner}-radius`);
        for (const part of value.split(/\s+/).filter(Boolean)) {
          if (!/^-?[\d.]+px$/.test(part)) {
            if (part !== '0') skipped.relative++;
            continue;
          }
          const px = parseFloat(part);
          if (px)
            g.add(own, seen, node, 'radius', 'border-radius', part, px, null);
        }
      }
    nodes.push({
      selector: g.selector(element),
      description: g.describe(element),
      exceptions: input.exceptions.flatMap((selector, index) =>
        g.closest(element, selector) ? [index] : [],
      ),
    });
    samples.push(...own);
  }
  return {
    url: location.href,
    rootFontSizePx:
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    typedOM,
    elements,
    truncated,
    nodes,
    samples,
    skipped,
  };
}
