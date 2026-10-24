import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

/**
 * Up to this window width the sidebars cover the text instead of docking.
 * The desktop window can shrink to 1000px, where both docked sidebars
 * (180px + 250px minimum) would leave the text barely 570px.
 */
export const NARROW_READER_MAX_WIDTH = 1199;
export const NARROW_READER_QUERY = `(max-width: ${NARROW_READER_MAX_WIDTH}px)`;

function subscribeNarrow(callback: () => void) {
  const media = window.matchMedia?.(NARROW_READER_QUERY);
  media?.addEventListener("change", callback);
  return () => media?.removeEventListener("change", callback);
}
export function useNarrowReader() {
  return useSyncExternalStore(
    subscribeNarrow,
    () => !!window.matchMedia?.(NARROW_READER_QUERY).matches,
    () => false,
  );
}

const editing =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
/** A menu, popover or dialog that is still open. */
export function popupOpen(root: Document = document) {
  return !!root.querySelector(
    '[data-popup-open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  );
}
/** Typing, or a popup that is still open. */
export function interactionOpen(root: Document = document) {
  const active = root.activeElement;
  return (
    (active instanceof Element && !!active.closest(editing)) || popupOpen(root)
  );
}

/**
 * Whether the reading toolbar is shown. Reading fades it out; the pointer at
 * the top, keyboard focus in the toolbar, or leaving immersion brings it back.
 */
export class ReaderChrome {
  visible = true;
  private pointer = false;
  private focused = false;
  private pinned = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private publish: (visible: boolean) => void,
    private held: () => boolean,
    private idle = 3000,
  ) {
    this.schedule();
  }
  /** Show the toolbar; a pinned toolbar waits for the next reading action. */
  reveal(pinned = false) {
    if (pinned) this.pinned = true;
    this.set(true);
    this.schedule();
  }
  /** The reader turned, scrolled or clicked into the text. */
  read() {
    // The pointer is with the text, even if the toolbar never saw it leave.
    this.pointer = false;
    this.pinned = false;
    if (!this.hide()) this.schedule();
  }
  get hovered() {
    return this.pointer;
  }
  pointerEnter() {
    this.pointer = true;
    this.reveal();
  }
  pointerLeave() {
    if (!this.pointer) return;
    this.pointer = false;
    this.schedule();
  }
  focusIn() {
    this.focused = true;
    this.reveal();
  }
  focusOut() {
    this.focused = false;
    this.schedule();
  }
  dispose() {
    clearTimeout(this.timer);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.visible) return;
    this.timer = setTimeout(() => {
      if (!this.hide()) this.schedule();
    }, this.idle);
  }
  private hide() {
    if (this.pointer || this.focused || this.pinned || this.held())
      return false;
    clearTimeout(this.timer);
    this.set(false);
    return true;
  }
  private set(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.publish(visible);
  }
}

function keyboardFocus(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Wires the toolbar and reading area with DOM listeners, so controls portaled
 * into the toolbar and events from reader frames follow the page structure.
 */
export function useReaderChrome(
  toolbar: RefObject<HTMLElement | null>,
  reading: RefObject<HTMLElement | null>,
  held: () => boolean,
) {
  const [visible, setVisible] = useState(true);
  const heldRef = useRef(held);
  heldRef.current = held;
  const [chrome] = useState(
    () => new ReaderChrome(setVisible, () => heldRef.current()),
  );
  useEffect(() => () => chrome.dispose(), [chrome]);
  useEffect(() => {
    const bar = toolbar.current;
    const pane = reading.current;
    const controller = new AbortController();
    const signal = controller.signal;
    // On macOS the shown toolbar is a window drag region, which receives no
    // pointer events. Turning it back into one under a resting pointer can
    // report a leave from inside the toolbar, and a real exit through a drag
    // area may never be reported; so a leave only counts outside the toolbar,
    // and pointer movement elsewhere (or reading) ends the hover as well.
    const inside = (event: PointerEvent) => {
      const box = bar!.getBoundingClientRect();
      return (
        event.clientX >= box.left &&
        event.clientX < box.right &&
        event.clientY >= box.top &&
        event.clientY < box.bottom
      );
    };
    bar?.addEventListener("pointerenter", () => chrome.pointerEnter(), {
      signal,
    });
    bar?.addEventListener(
      "pointermove",
      () => {
        if (!chrome.hovered) chrome.pointerEnter();
      },
      { signal },
    );
    bar?.addEventListener(
      "pointerleave",
      (event) => {
        if (!inside(event)) chrome.pointerLeave();
      },
      { signal },
    );
    document.addEventListener(
      "pointermove",
      (event) => {
        if (chrome.hovered && !bar?.contains(event.target as Node | null))
          chrome.pointerLeave();
      },
      { passive: true, signal },
    );
    bar?.addEventListener(
      "focusin",
      (event) => {
        // A clicked button keeps focus; only keyboard focus holds the toolbar.
        if (keyboardFocus(event.target)) chrome.focusIn();
        else chrome.reveal();
      },
      { signal },
    );
    bar?.addEventListener(
      "focusout",
      (event) => {
        if (!bar.contains(event.relatedTarget as Node | null))
          chrome.focusOut();
      },
      { signal },
    );
    for (const name of ["pointerdown", "wheel", "keydown"])
      pane?.addEventListener(name, () => chrome.read(), {
        capture: true,
        passive: true,
        signal,
      });
    return () => controller.abort();
  }, [chrome, toolbar, reading]);
  return { visible, chrome };
}
