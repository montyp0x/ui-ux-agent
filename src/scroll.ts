import type { ScrollPoint, ScrollRegion } from './contracts.js';

// Self-contained for Playwright serialization. Discovery and execution use the
// same hit test and scroll-chaining rules; models only choose offered action IDs.
export function scrollGeometry(
  request: { point: ScrollPoint; direction: 'up' | 'down' } | null,
): { regions: ScrollRegion[]; recipient: Element | null } {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const documentScroll = document.scrollingElement;
  const modal = Array.from(
    document.querySelectorAll(
      'dialog:modal, [role="dialog"][aria-modal="true"]',
    ),
  )
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        getComputedStyle(element).visibility !== 'hidden'
      );
    })
    .at(-1);
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
    recipient(point: ScrollPoint, direction: 'up' | 'down'): Element | null {
      let hit = document.elementFromPoint(point.x, point.y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit || (modal && !geometry.contains(modal, hit))) return null;
      for (
        let element: Element | null = hit;
        element;
        element = geometry.parent(element)
      ) {
        const style = getComputedStyle(element);
        const root = element === documentScroll;
        const scrollable = root
          ? !/hidden|clip/.test(style.overflowY) &&
            !/hidden|clip/.test(getComputedStyle(document.body).overflowY)
          : /auto|scroll/.test(style.overflowY);
        if (scrollable && element.scrollHeight > element.clientHeight + 1) {
          if (
            direction === 'up'
              ? element.scrollTop > 1
              : element.scrollTop + element.clientHeight <
                element.scrollHeight - 1
          )
            return element;
          if (/contain|none/.test(style.overscrollBehaviorY)) return null;
        }
      }
      return null;
    },
    bounds(element: Element): ScrollRegion['bounds'] | null {
      if (modal && !geometry.contains(modal, element)) return null;
      const rect =
        element === documentScroll
          ? { left: 0, top: 0, right: width, bottom: height }
          : element.getBoundingClientRect();
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
          Number(style.opacity) === 0
        )
          return null;
        if (node === element || node === documentScroll) continue;
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
      return right - left > 2 && bottom - top > 2
        ? { x: left, y: top, width: right - left, height: bottom - top }
        : null;
    },
  };
  if (request) {
    const recipient = geometry.recipient(request.point, request.direction);
    return {
      regions: [],
      recipient: recipient && geometry.bounds(recipient) ? recipient : null,
    };
  }
  const roots: ParentNode[] = [document];
  const elements: Element[] = [];
  for (let index = 0; index < roots.length; index++) {
    for (const element of Array.from(roots[index]!.querySelectorAll('*'))) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (
        ((element === documentScroll &&
          !/hidden|clip/.test(getComputedStyle(element).overflowY) &&
          !/hidden|clip/.test(getComputedStyle(document.body).overflowY)) ||
          /auto|scroll/.test(getComputedStyle(element).overflowY)) &&
        element.scrollHeight > element.clientHeight + 1
      )
        elements.push(element);
    }
  }
  const regions: ScrollRegion[] = [];
  const discovered: Element[] = [];
  for (const element of elements) {
    if (regions.length >= 12) break;
    const bounds = geometry.bounds(element);
    if (!bounds) continue;
    const points: ScrollPoint[] = [
      { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.7 },
    ];
    for (const y of [0.1, 0.5, 0.9])
      for (const x of [0.1, 0.5, 0.9])
        points.push({
          x: bounds.x + bounds.width * x,
          y: bounds.y + bounds.height * y,
        });
    const up =
      points.find((point) => geometry.recipient(point, 'up') === element) ??
      null;
    const down =
      points.find((point) => geometry.recipient(point, 'down') === element) ??
      null;
    let parent: string | null = null;
    for (
      let ancestor = geometry.parent(element);
      ancestor;
      ancestor = geometry.parent(ancestor)
    ) {
      const index = discovered.indexOf(ancestor);
      if (index >= 0) {
        parent = regions[index]!.id;
        break;
      }
    }
    const labelled = element
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map(
        (id) =>
          (element.getRootNode() as Document | ShadowRoot).getElementById(id)
            ?.textContent ?? '',
      )
      .join(' ');
    const label = (
      element.getAttribute('aria-label') ||
      labelled ||
      (element === documentScroll
        ? 'page'
        : element.matches('main, [role="main"]') || parent === null
          ? 'main content'
          : `scrollable panel ${regions.length + 1}`)
    )
      .trim()
      .slice(0, 200);
    regions.push({
      id: `s${regions.length}`,
      label,
      parent,
      bounds,
      x: element.scrollLeft,
      y: element.scrollTop,
      up,
      down,
    });
    discovered.push(element);
  }
  return { regions, recipient: null };
}
