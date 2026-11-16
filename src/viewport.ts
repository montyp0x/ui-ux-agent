import type { Viewport } from './contracts.js';

// Self-contained so the same geometry can run inside the page for observations,
// candidate discovery and independent visibility checks.
export function projectViewport(
  target: HTMLElement | SVGElement | null,
): Viewport & { targetVisible: boolean; targetName?: string } {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Object methods avoid transpiler-injected name helpers when serialized.
  const geometry = {
    parent(element: Element): Element | null {
      return (
        element.parentElement ??
        (element.getRootNode() instanceof ShadowRoot
          ? (element.getRootNode() as ShadowRoot).host
          : null)
      );
    },
    contains(ancestor: Element, descendant: Element): boolean {
      for (
        let node: Element | null = descendant;
        node;
        node = geometry.parent(node)
      )
        if (node === ancestor) return true;
      return false;
    },
    // The accessible-ish name reported for controls; shared with the target so
    // offered actions can be matched to observed controls exactly.
    controlName(element: Element): string {
      const labelled = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map(
          (id) =>
            (element.getRootNode() as Document | ShadowRoot).getElementById(id)
              ?.textContent ?? '',
        )
        .join(' ');
      const input = element as HTMLInputElement;
      const nativeLabel = input.labels?.length
        ? Array.from(input.labels)
            .map((label) => label.textContent ?? '')
            .join(' ')
        : undefined;
      return (
        element.getAttribute('aria-label') ??
        labelled ??
        element.getAttribute('alt') ??
        nativeLabel ??
        element.getAttribute('placeholder') ??
        (element as HTMLElement).innerText ??
        ''
      )
        .trim()
        .slice(0, 500);
    },
    visible(element: Element, rect: DOMRect): boolean {
      if (modal && !geometry.contains(modal, element)) return false;
      let left = Math.max(0, rect.left),
        right = Math.min(width, rect.right);
      let top = Math.max(0, rect.top),
        bottom = Math.min(height, rect.bottom);
      for (
        let node: Element | null = element;
        node;
        node = geometry.parent(node)
      ) {
        const style = getComputedStyle(node);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          Number(style.opacity) === 0
        )
          return false;
        if (node === element) continue;
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
      if (right <= left || bottom <= top) return false;
      for (const [x, y] of [
        [(left + right) / 2, (top + bottom) / 2],
        [left + 0.5, top + 0.5],
        [right - 0.5, bottom - 0.5],
      ]) {
        let hit = document.elementFromPoint(x!, y!);
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x!, y!);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        if (
          hit &&
          (geometry.contains(element, hit) || geometry.contains(hit, element))
        )
          return true;
      }
      return false;
    },
  };
  const modal = Array.from(
    document.querySelectorAll(
      'dialog:modal, [role="dialog"][aria-modal="true"]',
    ),
  )
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    })
    .at(-1);
  const output: Viewport & { targetVisible: boolean; targetName?: string } = {
    width,
    height,
    text: '',
    textTruncated: false,
    controls: [],
    canScrollUp: false,
    canScrollDown: false,
    scrollRegions: [],
    targetVisible: false,
  };
  if (target) {
    output.targetVisible = Array.from(target.getClientRects()).some((rect) =>
      geometry.visible(target, rect),
    );
    output.targetName = geometry.controlName(target);
    return output;
  }
  // An open modal dialog limits what is visible to its own content: named by
  // its label, else its first heading (its whole text would be the dialog).
  if (modal) {
    const labelled = modal
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    output.modal = (
      modal.getAttribute('aria-label') ??
      labelled ??
      modal.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')
        ?.textContent ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }
  const roots: ParentNode[] = [document.body];
  for (let index = 0; index < roots.length; index++)
    for (const element of Array.from(roots[index]!.querySelectorAll('*')))
      if (element.shadowRoot) roots.push(element.shadowRoot);
  let scanned = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > 10000 || output.text.length >= 12000) {
        output.textTruncated = true;
        break;
      }
      const element = node.parentElement;
      if (!element || element.closest('script, style, noscript, template'))
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (
        !Array.from(range.getClientRects()).some((rect) =>
          geometry.visible(element, rect),
        )
      )
        continue;
      const words: string[] = [];
      for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (
          Array.from(range.getClientRects()).some((rect) =>
            geometry.visible(element, rect),
          )
        )
          words.push(match[0]);
      }
      if (words.length) output.text += words.join(' ') + '\n';
    }
    if (output.textTruncated) break;
  }
  output.textTruncated ||= output.text.length > 12000;
  output.text = output.text.slice(0, 12000);
  for (const root of roots)
    for (const element of Array.from(
      root.querySelectorAll(
        'a, button, input, select, textarea, img[alt], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"]',
      ),
    )) {
      if (
        !Array.from(element.getClientRects()).some((rect) =>
          geometry.visible(element, rect),
        )
      )
        continue;
      if (output.controls.length >= 100) {
        output.textTruncated = true;
        break;
      }
      const input = element as HTMLInputElement;
      output.controls.push({
        role: element.getAttribute('role') ?? element.localName,
        name: geometry.controlName(element),
        value: input.type === 'password' ? undefined : input.value,
        checked:
          input.type === 'checkbox' || input.type === 'radio'
            ? input.checked
            : undefined,
        disabled:
          element.matches(':disabled') ||
          element.getAttribute('aria-disabled') === 'true',
      });
    }
  return output;
}
