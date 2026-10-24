// @vitest-environment jsdom
import { act, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type ReaderAdapter,
  type ReaderEvents,
  type TOCItem,
} from "@reader/core";
import { TooltipProvider } from "@reader/ui/components/tooltip";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { forwardReaderShortcut } from "./shortcuts/shortcuts";
import { NARROW_READER_MAX_WIDTH } from "./reader-chrome";

const state = vi.hoisted(() => ({
  panels: new Map<string, boolean>(),
  mounts: 0,
  unmounts: 0,
  events: undefined as ReaderEvents | undefined,
  adapter: undefined as unknown as ReaderAdapter,
  toc: [] as TOCItem[],
}));
vi.mock("@reader/api", () => ({
  api: {
    aiConfig: vi.fn(async () => ({
      primary: "",
      models: {},
      capabilities: {},
    })),
    chatSessions: vi.fn(async () => []),
    recoverAnnotations: vi.fn(async () => ({ checked: true })),
    annotations: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    blocks: vi.fn(async () => []),
  },
  setDiagnosticReporter: vi.fn(),
  blockImageURL: vi.fn(),
  publicationURL: vi.fn(),
}));
vi.mock("./progress", () => ({
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(async () => {}),
}));
vi.mock("./translation/PDFReadingView", async () => {
  const { useEffect } = await import("react");
  return {
    PDFReadingView: ({
      events,
      onReady,
    }: {
      events: ReaderEvents;
      onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
    }) => {
      state.events = events;
      useEffect(() => {
        state.mounts++;
        onReady(state.adapter, state.toc);
        return () => {
          state.unmounts++;
        };
      }, []);
      return <div className="reader-stage" />;
    },
  };
});
vi.mock("./chat/AssistantPanel", () => ({ AssistantPanel: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./DocumentOverview", () => ({ DocumentOverviewDialog: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./NotesPanel", () => ({ NotesPanel: () => null }));
// Records the docked panel sizes the way the panel library exposes them.
vi.mock("@reader/ui/components/resizable", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  const Panel = ({
    id,
    panelRef,
    children,
  }: {
    id?: string;
    panelRef?: Ref<unknown>;
    children?: ReactNode;
  }) => {
    useImperativeHandle(
      panelRef,
      () => ({
        isCollapsed: () => state.panels.get(id!) === false,
        collapse: () => state.panels.set(id!, false),
        expand: () => state.panels.set(id!, true),
      }),
      [id],
    );
    return <div>{children}</div>;
  };
  return {
    ResizablePanel: Panel,
    ResizablePanelGroup: ({
      elementRef,
      children,
    }: {
      elementRef?: Ref<HTMLDivElement>;
      children?: ReactNode;
    }) => <div ref={elementRef}>{children}</div>,
    ResizableHandle: () => null,
    usePanelRef: () => useRef(null),
  };
});

// Window widths of the desktop app: its smallest window and a common one.
const NATIVE_MIN_WIDTH = 1000;
const WIDE_WIDTH = 1440;
let width = WIDE_WIDTH;
const mediaListeners = new Set<() => void>();
/** Evaluates width media queries as the browser would at `width`. */
const mediaMatches = (query: string) => {
  const limits = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  return (
    limits.length > 0 &&
    limits.every(([, side, px]) =>
      side === "max" ? width <= Number(px) : width >= Number(px),
    )
  );
};
const resize = async (value: number) => {
  width = value;
  await act(async () => mediaListeners.forEach((listener) => listener()));
};
let root: Root, host: HTMLDivElement;
const doc = paper({ id: "layout-doc", title: "Layout" });
const render = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <Workspace
          document={doc}
          theme={defaultTheme}
          onBack={() => {}}
          onSettings={() => {}}
        />
      </TooltipProvider>,
    ),
  );
const toolbar = () => document.querySelector<HTMLElement>(".reader-toolbar")!;
const toolbarButton = (label: string) =>
  toolbar().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const navigation = () =>
  document.querySelector<HTMLElement>(".reader-sidebar")!;
const assistant = () =>
  document.querySelector<HTMLElement>(".assistant-sidebar")!;
const composer = () =>
  document.querySelector<HTMLTextAreaElement>('[aria-label="向 AI 提问"]')!;
const escape = () =>
  act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
  });
const frame = () => act(async () => vi.advanceTimersByTime(20));
const type = async (value: string) => {
  const area = composer();
  const set = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    set.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return mediaMatches(query);
    },
    addEventListener: (_: string, listener: () => void) =>
      mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      mediaListeners.delete(listener),
  }));
  width = WIDE_WIDTH;
  state.panels.clear();
  state.mounts = 0;
  state.unmounts = 0;
  state.toc = [
    {
      id: "c1",
      label: "第一章",
      location: { type: "pdf", page: 3 },
      children: [],
    },
  ];
  state.adapter = {
    goTo: vi.fn(async () => {}),
    clearSelection: vi.fn(),
    getLocation: () => ({ type: "pdf", page: 1 }),
  } as unknown as ReaderAdapter;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  mediaListeners.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("fades the toolbar while reading in a frame and brings it back on request", async () => {
  await render();
  expect(toolbar().dataset.chrome).toBe("shown");
  // Reading inside a Readium frame only reaches the app as an engine event.
  await act(async () => state.events!.epubInteraction!());
  expect(toolbar().dataset.chrome).toBe("hidden");

  await act(async () => {
    toolbar().dispatchEvent(new MouseEvent("pointerenter"));
  });
  expect(toolbar().dataset.chrome).toBe("shown");
  await act(async () => {
    toolbar().dispatchEvent(new MouseEvent("pointerleave"));
    vi.advanceTimersByTime(3000);
  });
  expect(toolbar().dataset.chrome).toBe("hidden");

  // Escape pressed inside a frame is forwarded and leaves immersion.
  await act(async () => {
    forwardReaderShortcut(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(toolbar().dataset.chrome).toBe("shown");
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(toolbar().dataset.chrome).toBe("shown");
  await act(async () => state.events!.epubInteraction!());
  expect(toolbar().dataset.chrome).toBe("hidden");

  await act(async () => toolbarButton("设置").focus());
  expect(toolbar().dataset.chrome).toBe("shown");
});

it("keeps the toolbar during a selection or a typed question", async () => {
  await render();
  await act(async () =>
    state.events!.selection({
      text: "注意力",
      location: { type: "pdf", page: 1 },
    }),
  );
  await act(async () => state.events!.epubInteraction!());
  await act(async () => vi.advanceTimersByTime(9000));
  expect(toolbar().dataset.chrome).toBe("shown");
  // Escape that clears a selection does not also pin the toolbar.
  await escape();
  await act(async () => state.events!.selection(null));
  await act(async () => vi.advanceTimersByTime(3000));
  expect(toolbar().dataset.chrome).toBe("hidden");

  await act(async () =>
    toolbar().dispatchEvent(new MouseEvent("pointerenter")),
  );
  await act(async () =>
    toolbar().dispatchEvent(new MouseEvent("pointerleave")),
  );
  await act(async () => composer().focus());
  await act(async () => state.events!.epubInteraction!());
  await act(async () => vi.advanceTimersByTime(9000));
  expect(toolbar().dataset.chrome).toBe("shown");
});

it("docks sidebars at 1440px and covers the text down to the smallest 1000px window", async () => {
  await render();
  expect(navigation().dataset.drawer).toBeUndefined();
  expect(assistant().dataset.drawer).toBeUndefined();
  await resize(NARROW_READER_MAX_WIDTH + 1);
  expect(navigation().dataset.drawer).toBeUndefined();
  await resize(NARROW_READER_MAX_WIDTH);
  expect(navigation().dataset.drawer).toBeDefined();
  await resize(NATIVE_MIN_WIDTH);
  expect(navigation().dataset.drawer).toBeDefined();
  expect(assistant().dataset.drawer).toBeDefined();
  expect(state.panels.get("navigation")).toBe(false);
  expect(state.panels.get("assistant")).toBe(false);
  await resize(WIDE_WIDTH);
  expect(navigation().dataset.drawer).toBeUndefined();
  expect(state.panels.get("navigation")).toBe(true);
  expect(state.panels.get("assistant")).toBe(true);
});

it("covers the text with one sidebar in narrow windows and restores the docked layout", async () => {
  await render();
  expect(state.panels.get("navigation")).not.toBe(false);
  // Close the docked assistant first; widening later must keep that choice.
  await act(async () => toolbarButton("Agent 与批注").click());
  expect(state.panels.get("assistant")).toBe(false);
  expect(assistant().hasAttribute("inert")).toBe(true);

  await resize(NATIVE_MIN_WIDTH);
  expect(state.panels.get("navigation")).toBe(false);
  expect(navigation().dataset.drawer).toBeDefined();
  expect(navigation().dataset.open).toBe("false");
  expect(navigation().hasAttribute("inert")).toBe(true);

  await act(async () => toolbarButton("目录与搜索").click());
  await frame();
  expect(navigation().dataset.open).toBe("true");
  expect(navigation().hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(navigation());
  // The panel layout under the drawer does not change, so the text stays put.
  expect(state.panels.get("navigation")).toBe(false);
  expect(state.panels.get("assistant")).toBe(false);

  // Opening the other side replaces it.
  await act(async () => toolbarButton("Agent 与批注").click());
  await frame();
  expect(navigation().dataset.open).toBe("false");
  expect(assistant().dataset.open).toBe("true");
  expect(toolbarButton("Agent 与批注").getAttribute("aria-expanded")).toBe(
    "true",
  );

  await escape();
  await frame();
  expect(assistant().dataset.open).toBe("false");
  expect(document.activeElement).toBe(toolbarButton("Agent 与批注"));

  await act(async () => toolbarButton("目录与搜索").click());
  await frame();
  await act(async () =>
    document.querySelector<HTMLElement>(".reader-drawer-backdrop")!.click(),
  );
  await frame();
  expect(navigation().dataset.open).toBe("false");
  expect(document.activeElement).toBe(toolbarButton("目录与搜索"));

  await resize(WIDE_WIDTH);
  expect(navigation().dataset.drawer).toBeUndefined();
  expect(document.querySelector(".reader-drawer-backdrop")).toBeNull();
  expect(state.panels.get("navigation")).toBe(true);
  expect(state.panels.get("assistant")).toBe(false);
  expect(navigation().dataset.open).toBe("true");
  expect(assistant().dataset.open).toBe("false");
  expect(state.mounts).toBe(1);
  expect(state.unmounts).toBe(0);
});

it("keeps a question being typed, in one composer, across window sizes", async () => {
  await render();
  await type("这一段的论证是什么？");
  const area = composer();
  await act(async () => area.focus());

  await resize(NATIVE_MIN_WIDTH);
  expect(assistant().dataset.open).toBe("true");
  expect(assistant().dataset.drawer).toBeDefined();
  expect(composer()).toBe(area);
  expect(document.activeElement).toBe(area);
  expect(area.value).toBe("这一段的论证是什么？");
  expect(document.querySelectorAll('[aria-label="向 AI 提问"]')).toHaveLength(
    1,
  );
  // A drawer in use keeps the toolbar too.
  await act(async () => state.events!.epubInteraction!());
  await act(async () => vi.advanceTimersByTime(9000));
  expect(toolbar().dataset.chrome).toBe("shown");

  await resize(WIDE_WIDTH);
  expect(assistant().dataset.drawer).toBeUndefined();
  expect(assistant().dataset.open).toBe("true");
  expect(composer()).toBe(area);
  expect(area.value).toBe("这一段的论证是什么？");
  expect(state.mounts).toBe(1);
  expect(state.unmounts).toBe(0);
});

it("shows the text after choosing a chapter from the narrow table of contents", async () => {
  await resize(NATIVE_MIN_WIDTH);
  await render();
  await act(async () => toolbarButton("目录与搜索").click());
  await frame();
  const chapter = [...navigation().querySelectorAll("button")].find((button) =>
    button.textContent?.includes("第一章"),
  )!;
  await act(async () => chapter.click());
  await frame();
  expect(state.adapter.goTo).toHaveBeenCalledWith({ type: "pdf", page: 3 });
  expect(navigation().dataset.open).toBe("false");
  expect(document.activeElement).not.toBe(toolbarButton("目录与搜索"));
});
