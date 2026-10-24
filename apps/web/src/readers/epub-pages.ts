/** Keys inside these controls keep their own meaning. */
const ownKeys =
  '[role="dialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="slider"], [role="radiogroup"], [data-slot="popover-content"], .reader-sidebar, .assistant-sidebar, .translation-document';

/**
 * Page keys pressed outside the book frame: from the page itself or the
 * reader around it, never from inputs, side panels or menus.
 */
export function ownsPageKey(event: KeyboardEvent, scope: Element) {
  if (event.defaultPrevented) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target === target.ownerDocument.body) return true;
  if (target.closest(ownKeys)) return false;
  // Space keeps activating a focused button or link.
  if (event.key === " " && target.closest("button, a")) return false;
  return scope.contains(target) || !!target.closest(".workspace");
}

/** The visible screen of a paginated Readium frame, counted within its chapter. */
export function framePage(wnd: Window) {
  const root = wnd.document.scrollingElement;
  const width = wnd.innerWidth;
  if (!root || !width) return;
  const pages = Math.max(1, Math.round(root.scrollWidth / width));
  return {
    page: Math.min(pages, Math.round(Math.abs(root.scrollLeft) / width) + 1),
    pages,
  };
}

/** One character of a range, by its offset in `range.toString()`. */
export function textRangeIn(range: Range, index: number): Range | undefined {
  const doc = range.startContainer.ownerDocument;
  const common = range.commonAncestorContainer;
  const root = common.nodeType === 3 ? common.parentNode : common;
  if (!doc || !root || index < 0) return;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let remaining = index;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const length = (node as Text).length;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : length;
    if (remaining < to - from) {
      const char = doc.createRange();
      char.setStart(node, from + remaining);
      char.setEnd(node, from + remaining + 1);
      return char;
    }
    remaining -= Math.max(0, to - from);
  }
}

/**
 * The first item not yet passed, for items in reading order: blocks, or the
 * characters of one block. Unmeasured items count as not passed.
 */
export function firstUnpassed(
  count: number,
  passed: (index: number) => boolean,
) {
  let low = 0,
    high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (passed(middle)) low = middle + 1;
    else high = middle;
  }
  return low;
}
