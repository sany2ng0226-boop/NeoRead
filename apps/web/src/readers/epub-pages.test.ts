// @vitest-environment jsdom
// Pages are Readium's; scrolling and side-by-side reading use the main-document
// renderer. These cases check that both read and write the same positions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Decoration,
  EpubNavigatorListeners,
  EpubPreferences,
} from "@readium/navigator";
import {
  defaultTheme,
  type Annotation,
  type Document as ReaderDocument,
  type EPUBLocation,
  type EPUBReadingBlock,
  type ReaderPagination,
} from "@reader/core";
import { Locator, Publication } from "@readium/shared";
import { selectionLocator, textRangeAt } from "./selection-locator";
import { resolveEPUBLocation } from "./epub-web-location";
import {
  firstUnpassed,
  framePage,
  ownsPageKey,
  textRangeIn,
} from "./epub-pages";

const bridge = vi.hoisted(() => ({
  listeners: undefined as EpubNavigatorListeners | undefined,
  initial: undefined as Locator | undefined,
  preferences: [] as EpubPreferences[],
  apply: vi.fn(),
  forward: vi.fn(),
  backward: vi.fn(),
  frame: undefined as HTMLIFrameElement | undefined,
}));
vi.mock("@readium/navigator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@readium/navigator")>()),
  DecorationLayout: { Boxes: "boxes" },
  DecorationWidth: { Wrap: "wrap" },
  EpubNavigator: class {
    constructor(
      _container: HTMLElement,
      _publication: unknown,
      listeners: EpubNavigatorListeners,
      _positions: unknown,
      initial: Locator | undefined,
      options: { preferences: EpubPreferences },
    ) {
      bridge.listeners = listeners;
      bridge.initial = initial;
      bridge.preferences.push(options.preferences);
    }
    framePool = { update: async () => {} };
    get _cframes() {
      return [{ iframe: bridge.frame, source: "blob:chapter" }];
    }
    goForward(_animated: boolean, done: (ok: boolean) => void) {
      bridge.forward();
      done(true);
    }
    goBackward(_animated: boolean, done: (ok: boolean) => void) {
      bridge.backward();
      done(true);
    }
    go(_locator: Locator, _animated: boolean, done: (ok: boolean) => void) {
      done(true);
    }
    async load() {
      return true;
    }
    async destroy() {}
    async submitPreferences(preferences: EpubPreferences) {
      bridge.preferences.push(preferences);
    }
    registerDecorationObserver() {}
    unregisterDecorationObserver() {}
    applyDecorations(decorations: Decoration[], group: string) {
      bridge.apply(decorations, group);
    }
  },
}));
const blocks: EPUBReadingBlock[] = [];
vi.mock("@reader/api", () => ({
  api: { epubBlocks: vi.fn(async () => blocks), search: vi.fn() },
  publicationURL: (_id: string, path: string) => `/pub/${path}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("../reading-links", () => ({ openExternalLink: vi.fn() }));
import { EPUBReaderAdapter } from "./epub";
import { openExternalLink } from "../reading-links";

const chapter =
  "<html><body><p>Alpha beta.</p><p>Same words. Same words.</p></body></html>";
/** Block records shaped like the server's: original body-text and DOM ranges. */
function chapterBlocks(): EPUBReadingBlock[] {
  const doc = new DOMParser().parseFromString(chapter, "text/html");
  const base = Locator.deserialize({
    href: "chapter.xhtml",
    type: "application/xhtml+xml",
  })!;
  let offset = 0;
  return Array.from(doc.querySelectorAll("p")).map((p, i) => {
    const text = p.textContent!;
    const range = textRangeAt(doc, offset, offset + text.length)!;
    offset += text.length;
    return {
      id: `b${i + 1}`,
      label: "text",
      text,
      location: {
        type: "epub",
        href: "chapter.xhtml",
        blockId: `b${i + 1}`,
        start: 0,
        end: text.length,
        quote: text,
        locator: JSON.stringify(selectionLocator(base, range)!.serialize()),
      },
    };
  });
}
const saved = (locator: Locator | undefined) =>
  locator?.serialize() as {
    locations: { textRange?: { start: number; end: number } };
    text?: { highlight?: string };
  };

let host: HTMLDivElement;
let adapter: EPUBReaderAdapter;
let events: {
  location: ReturnType<typeof vi.fn>;
  selection: ReturnType<typeof vi.fn>;
  pagination: ReturnType<typeof vi.fn>;
  internalLink: ReturnType<typeof vi.fn>;
};
let scrollLeft = 0;
const paged = { ...defaultTheme, epubFlow: "paginated" as const };

beforeEach(() => {
  blocks.splice(0, blocks.length, ...chapterBlocks());
  bridge.preferences = [];
  bridge.apply.mockClear();
  bridge.forward.mockClear();
  bridge.backward.mockClear();
  scrollLeft = 200;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      text: async () => chapter,
      json: async () => ({
        metadata: { title: "Book" },
        readingOrder: [
          {
            href: "chapter.xhtml",
            type: "application/xhtml+xml",
            title: "第一章",
          },
          { href: "next.xhtml", type: "application/xhtml+xml" },
        ],
      }),
    }),
  );
  vi.spyOn(Publication.prototype, "positionsFromManifest").mockResolvedValue([
    Locator.deserialize({
      href: "chapter.xhtml",
      type: "application/xhtml+xml",
      locations: { position: 1 },
    })!,
  ]);
  host = document.createElement("div");
  document.body.append(host);
  events = {
    location: vi.fn(),
    selection: vi.fn(),
    pagination: vi.fn(),
    internalLink: vi.fn(),
  };
});
afterEach(async () => {
  await adapter?.destroy();
  bridge.frame?.remove();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(progress?: EPUBLocation, theme = paged) {
  adapter = new EPUBReaderAdapter(host, events as never);
  adapter.preferTheme(theme);
  await adapter.open({ id: "book", type: "epub", progress } as ReaderDocument);
  return adapter;
}
/**
 * A paged frame: body characters sit 10px apart left to right, a screen is
 * 100px wide and scrolled by `scrollLeft`.
 */
function pagedFrame() {
  const frame = document.createElement("iframe");
  host.append(frame);
  bridge.frame = frame;
  const wnd = frame.contentWindow!;
  wnd.document.documentElement.innerHTML = chapter.replace(/<\/?html>/g, "");
  Object.defineProperty(wnd, "innerWidth", { value: 100 });
  Object.defineProperty(wnd.document, "scrollingElement", {
    value: wnd.document.documentElement,
  });
  Object.defineProperties(wnd.document.documentElement, {
    scrollWidth: { value: 340 },
    scrollLeft: { get: () => scrollLeft },
  });
  const at = (node: Node, offset: number) => {
    const prefix = wnd.document.createRange();
    prefix.selectNodeContents(wnd.document.body);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  };
  const char = (index: number) =>
    new DOMRect(index * 10 - scrollLeft, 20, 10, 20);
  const RangeType = (wnd as unknown as { Range: typeof Range }).Range;
  RangeType.prototype.getClientRects = function (this: Range) {
    const start = at(this.startContainer, this.startOffset);
    const end = Math.max(start, at(this.endContainer, this.endOffset) - 1);
    return [char(start), char(end)] as unknown as DOMRectList;
  };
  RangeType.prototype.getBoundingClientRect = function (this: Range) {
    return char(at(this.startContainer, this.startOffset));
  };
  bridge.listeners!.frameLoaded(wnd);
  return wnd;
}

describe("Readium pages", () => {
  it("lays out facing pages through Readium preferences and one column while scrolling", async () => {
    await open();
    const initial = bridge.preferences[0];
    expect(initial).toMatchObject({ scroll: false, columnCount: 2 });
    expect(initial.fontFamily).toContain("Songti SC");
    expect(initial.textAlign).toBe("justify");
    await adapter.setTheme({ ...paged, fontFamily: "sans-serif" });
    expect(bridge.preferences.at(-1)?.fontFamily).toContain("PingFang SC");
    await adapter.setTheme({ ...paged, epubFlow: "scroll" });
    expect(bridge.preferences.at(-1)).toMatchObject({
      scroll: true,
      columnCount: 1,
    });
  });

  it("opens a position saved while scrolling at the same repeated character", async () => {
    // The second "Same" of block b2: body text offset 11 + 12.
    await open({
      type: "epub",
      href: "chapter.xhtml",
      blockId: "b2",
      start: 12,
      end: 12,
    });
    expect(saved(bridge.initial).locations.textRange).toEqual({
      start: 23,
      end: 24,
    });
    expect(saved(bridge.initial).text?.highlight).toBe("S");
  });

  it("draws notes saved while scrolling on their exact occurrence, and keeps mismatched ones unresolved", async () => {
    await open();
    const note = (id: string, quote: string): Annotation => ({
      id,
      documentId: "book",
      kind: "highlight",
      location: {
        type: "epub",
        href: "chapter.xhtml",
        blockId: "b2",
        start: 12,
        end: 22,
        quote,
      },
      quote,
      note: "",
      color: "#facc15",
      createdAt: "",
    });
    await adapter.highlight([note("kept", "Same words")]);
    const [decorations] = bridge.apply.mock.calls.at(-1)! as [Decoration[]];
    expect(saved(decorations[0].locator).locations.textRange).toEqual({
      start: 23,
      end: 33,
    });
    await expect(
      adapter.highlight([note("stale", "Other text")]),
    ).rejects.toThrow("1 条批注暂时无法定位");
  });

  it("reports the first character on screen as a block position, with chapter screens", async () => {
    await open();
    pagedFrame();
    bridge.listeners!.positionChanged(
      Locator.deserialize({
        href: "chapter.xhtml",
        type: "application/xhtml+xml",
        locations: { progression: 0.6 },
      })!,
    );
    // Screen 3 starts at body character 20, inside b2 ("Same words…") at 9.
    const [location] = events.location.mock.calls.at(-1)! as [EPUBLocation];
    expect(location).toMatchObject({
      href: "chapter.xhtml",
      blockId: "b2",
      start: 9,
      end: 9,
    });
    expect(JSON.parse(location.locator!).locations.progression).toBe(0.6);
    await vi.waitFor(() =>
      expect(events.pagination).toHaveBeenLastCalledWith({
        chapter: "第一章",
        page: 3,
        pages: 3,
        first: false,
        last: false,
      } satisfies ReaderPagination),
    );
    // The scrolling renderer restores the same characters from it.
    expect(resolveEPUBLocation(location, blocks)[0]).toMatchObject({
      block: { id: "b2" },
      start: 9,
    });
  });

  it("keeps Readium selections readable by the scrolling renderer", () => {
    const doc = new DOMParser().parseFromString(chapter, "text/html");
    const range = textRangeAt(doc, 23, 33)!;
    const exact = selectionLocator(
      Locator.deserialize({
        href: "chapter.xhtml",
        type: "application/xhtml+xml",
      })!,
      range,
    )!;
    const location: EPUBLocation = {
      type: "epub",
      href: "chapter.xhtml",
      locator: JSON.stringify(exact.serialize()),
      quote: "Same words",
    };
    expect(resolveEPUBLocation(location, blocks)).toEqual([
      expect.objectContaining({ block: blocks[1], start: 12, end: 22 }),
    ]);
  });

  it("turns pages from the reader around the frame, not from inputs or panels", async () => {
    await open();
    host.tabIndex = 0;
    host.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await vi.waitFor(() => expect(bridge.forward).toHaveBeenCalledTimes(1));
    const input = document.createElement("textarea");
    const panel = document.createElement("div");
    panel.className = "assistant-sidebar";
    document.body.append(input, panel);
    for (const target of [input, panel])
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.backward).not.toHaveBeenCalled();
    input.remove();
    panel.remove();
  });

  it("opens web links outside and remembers the origin of book links", async () => {
    await open();
    const wnd = pagedFrame();
    expect(
      bridge.listeners!.handleLocator(
        Locator.deserialize({
          href: "https://example.com/a",
          type: "text/html",
        })!,
      ),
    ).toBe(true);
    expect(openExternalLink).toHaveBeenCalledWith("https://example.com/a");
    const link = wnd.document.createElement("a");
    link.href = "next.xhtml#note-1";
    link.setAttribute("href", "next.xhtml#note-1");
    wnd.document.body.append(link);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events.internalLink).toHaveBeenCalledTimes(1);
  });
});

describe("page helpers", () => {
  it("counts screens of a paged frame", () => {
    const wnd = {
      innerWidth: 500,
      document: { scrollingElement: { scrollWidth: 2000, scrollLeft: 1000 } },
    } as unknown as Window;
    expect(framePage(wnd)).toEqual({ page: 3, pages: 4 });
  });
  it("finds characters across inline markup", () => {
    const doc = new DOMParser().parseFromString(
      "<p>ab<b>cd</b>ef</p>",
      "text/html",
    );
    const range = doc.createRange();
    range.setStart(doc.querySelector("p")!.firstChild!, 1);
    range.setEnd(doc.querySelector("p")!.lastChild!, 1);
    expect(textRangeIn(range, 0)?.toString()).toBe("b");
    expect(textRangeIn(range, 2)?.toString()).toBe("d");
    expect(textRangeIn(range, 3)?.toString()).toBe("e");
    expect(textRangeIn(range, 4)).toBeUndefined();
    expect(firstUnpassed(10, (i) => i < 7)).toBe(7);
  });
  it("leaves page keys to inputs, menus and side panels", () => {
    const scope = document.createElement("div");
    const workspace = document.createElement("div");
    workspace.className = "workspace";
    const button = document.createElement("button");
    workspace.append(scope, button);
    document.body.append(workspace);
    const key = (target: Element, name = "ArrowRight") => {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true });
      Object.defineProperty(event, "target", { value: target });
      return ownsPageKey(event, scope);
    };
    expect(key(scope)).toBe(true);
    expect(key(button)).toBe(true);
    expect(key(button, " ")).toBe(false);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    workspace.append(menu);
    expect(key(menu)).toBe(false);
    workspace.remove();
  });
});
