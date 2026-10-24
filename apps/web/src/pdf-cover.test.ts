// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Page = {
  width: number;
  height: number;
  rotate?: number;
  broken?: boolean;
};
const pdf = {
  pages: [] as number[],
  options: [] as Record<string, unknown>[],
  renders: [] as {
    width: number;
    height: number;
    params: Record<string, unknown>;
  }[],
  destroyed: 0,
  destroyCalls: 0,
  // When set, PDF.js teardown waits until the test lets it finish.
  holdClose: false,
  closing: [] as (() => void)[],
  open: 0,
  peak: 0,
  // Per URL: the first page, an error, or a promise that never settles.
  files: new Map<string, Page | Error | "hang">(),
};
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/worker.js",
}));
const fakePDFJS = {
  GlobalWorkerOptions: { workerSrc: "" },
  AnnotationMode: { DISABLE: 0 },
  getDocument: (options: { url: string }) => {
    pdf.options.push(options);
    pdf.open++;
    pdf.peak = Math.max(pdf.peak, pdf.open);
    let closed = false;
    let fail: (error: Error) => void = () => {};
    const file = pdf.files.get(options.url);
    const promise = new Promise((resolve, reject) => {
      fail = reject;
      if (file === "hang") return;
      if (!file || file instanceof Error)
        return reject(file ?? new Error("missing"));
      resolve({
        getPage: async (n: number) => {
          pdf.pages.push(n);
          return {
            getViewport: ({ scale }: { scale: number }) => {
              const turned = (file.rotate ?? 0) % 180 !== 0;
              return {
                width: (turned ? file.height : file.width) * scale,
                height: (turned ? file.width : file.height) * scale,
              };
            },
            render: (params: {
              canvas: HTMLCanvasElement;
              [key: string]: unknown;
            }) => {
              pdf.renders.push({
                width: params.canvas.width,
                height: params.canvas.height,
                params,
              });
              return {
                promise: file.broken
                  ? Promise.reject(new Error("bad image"))
                  : Promise.resolve(),
                cancel: vi.fn(),
              };
            },
          };
        },
      });
    });
    return {
      promise,
      destroy: async () => {
        pdf.destroyCalls++;
        if (closed) return;
        closed = true;
        fail(new Error("destroyed"));
        if (pdf.holdClose)
          await new Promise<void>((resolve) => pdf.closing.push(resolve));
        pdf.open--;
        pdf.destroyed++;
      },
    };
  },
};
const { pdfCoverRenderer, PDF_COVER_BOX, PDF_COVER_CONCURRENCY } =
  await import("./pdf-cover");
let renderPDFCover: ReturnType<typeof pdfCoverRenderer>;
let loads = 0;

beforeEach(() => {
  loads = 0;
  renderPDFCover = pdfCoverRenderer(async () => {
    loads++;
    return fakePDFJS as unknown as typeof import("pdfjs-dist");
  });
  Object.assign(pdf, {
    open: 0,
    peak: 0,
    destroyed: 0,
    destroyCalls: 0,
    holdClose: false,
  });
  pdf.closing.length = 0;
  pdf.pages.length = pdf.options.length = pdf.renders.length = 0;
  pdf.files.clear();
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
  ) {
    done(new Blob([`${this.width}x${this.height}`], { type: "image/png" }));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const signal = () => new AbortController().signal;

it("draws only the first page, whole, within the cover size, then closes the file", async () => {
  pdf.files.set("/a.pdf", { width: 600, height: 800 });
  const blob = await renderPDFCover("/a.pdf", signal());
  expect(blob?.type).toBe("image/png");
  expect(pdf.pages).toEqual([1]);
  const [{ width, height, params }] = pdf.renders;
  // Fits the box at twice the CSS size, keeping the page's proportions.
  expect(width).toBeLessThanOrEqual(PDF_COVER_BOX.width * 2);
  expect(height).toBeLessThanOrEqual(PDF_COVER_BOX.height * 2);
  expect(width / height).toBeCloseTo(600 / 800, 2);
  expect(params.background).toBe("#ffffff");
  expect(params.annotationMode).toBe(0);
  expect(pdf.options[0]).toMatchObject({
    url: "/a.pdf",
    disableAutoFetch: true,
    disableStream: true,
  });
  expect(pdf.destroyed).toBe(1);
  expect(pdf.open).toBe(0);
});

it("keeps landscape and rotated first pages the right way round", async () => {
  pdf.files.set("/wide.pdf", { width: 1000, height: 500 });
  pdf.files.set("/turned.pdf", { width: 600, height: 800, rotate: 90 });
  await renderPDFCover("/wide.pdf", signal());
  await renderPDFCover("/turned.pdf", signal());
  expect(pdf.renders[0].width).toBeGreaterThan(pdf.renders[0].height);
  expect(pdf.renders[1].width / pdf.renders[1].height).toBeCloseTo(
    800 / 600,
    2,
  );
});

it("gives up quietly on missing, damaged or protected files", async () => {
  const locked = Object.assign(new Error("No password given"), {
    name: "PasswordException",
  });
  pdf.files.set("/locked.pdf", locked);
  pdf.files.set("/bad.pdf", new Error("Invalid PDF structure"));
  for (const url of ["/locked.pdf", "/bad.pdf", "/missing.pdf"])
    expect(await renderPDFCover(url, signal())).toBeUndefined();
  expect(pdf.open).toBe(0);
  expect(pdf.renders).toHaveLength(0);
});

it("lets a canceled or stalled file go, and frees its place", async () => {
  vi.useFakeTimers();
  pdf.files.set("/slow.pdf", "hang");
  const controller = new AbortController();
  const canceled = renderPDFCover("/slow.pdf", controller.signal);
  await vi.waitFor(() => expect(pdf.open).toBe(1));
  controller.abort();
  expect(await canceled).toBeUndefined();
  expect(pdf.open).toBe(0);

  const stalled = renderPDFCover("/slow.pdf", signal());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await stalled).toBeUndefined();
  expect(pdf.open).toBe(0);
});

it("opens a bounded number of files at once and skips canceled waiters", async () => {
  pdf.files.set("/slow.pdf", "hang");
  pdf.files.set("/ok.pdf", { width: 600, height: 800 });
  const controllers = Array.from(
    { length: PDF_COVER_CONCURRENCY },
    () => new AbortController(),
  );
  const busy = controllers.map((c) => renderPDFCover("/slow.pdf", c.signal));
  const skipped = new AbortController();
  const waiting = renderPDFCover("/ok.pdf", skipped.signal);
  const next = renderPDFCover("/ok.pdf", signal());
  await vi.waitFor(() => expect(pdf.open).toBe(PDF_COVER_CONCURRENCY));
  skipped.abort();
  expect(await waiting).toBeUndefined();
  controllers[0].abort();
  expect(await next).toBeInstanceOf(Blob);
  controllers.forEach((c) => c.abort());
  await Promise.all(busy);
  expect(pdf.peak).toBe(PDF_COVER_CONCURRENCY);
  // The canceled waiter never loaded PDF.js or opened its file.
  expect(loads).toBe(PDF_COVER_CONCURRENCY + 1);
  expect(pdf.options.filter((o) => o.url === "/ok.pdf")).toHaveLength(1);
  expect(pdf.open).toBe(0);
});

/** A signal that is aborted right as its waiter is granted a slot. */
function abortedOnGrant() {
  const listeners = new Set<EventListener>();
  let aborted = false;
  const reason = new DOMException("Aborted", "AbortError");
  return {
    get aborted() {
      return aborted;
    },
    reason,
    throwIfAborted() {
      if (aborted) throw reason;
    },
    addEventListener: (_: string, listener: EventListener) =>
      listeners.add(listener),
    removeEventListener(_: string, listener: EventListener) {
      listeners.delete(listener);
      if (aborted) return;
      aborted = true;
      listeners.forEach((l) => l(new Event("abort")));
    },
  } as unknown as AbortSignal;
}

it("passes on a slot granted to a waiter that was canceled before it resumed", async () => {
  pdf.files.set("/slow.pdf", "hang");
  pdf.files.set("/ok.pdf", { width: 600, height: 800 });
  const controllers = Array.from(
    { length: PDF_COVER_CONCURRENCY },
    () => new AbortController(),
  );
  const busy = controllers.map((c) => renderPDFCover("/slow.pdf", c.signal));
  const granted = Array.from({ length: PDF_COVER_CONCURRENCY }, () =>
    renderPDFCover("/ok.pdf", abortedOnGrant()),
  );
  const live = renderPDFCover("/ok.pdf", signal());
  await vi.waitFor(() => expect(pdf.open).toBe(PDF_COVER_CONCURRENCY));
  // Both slots free up together; both waiters they go to are already gone.
  controllers.forEach((c) => c.abort());
  expect(await Promise.all(granted)).toEqual([undefined, undefined]);
  // The remaining card draws without another card arriving to wake it.
  expect(await live).toBeInstanceOf(Blob);
  await Promise.all(busy);
  expect(pdf.options.filter((o) => o.url === "/ok.pdf")).toHaveLength(1);
  expect(pdf.open).toBe(0);
});

it("keeps a closing file's slot until PDF.js has torn it down", async () => {
  pdf.holdClose = true;
  pdf.files.set("/slow.pdf", "hang");
  pdf.files.set("/ok.pdf", { width: 600, height: 800 });
  const controllers = Array.from(
    { length: PDF_COVER_CONCURRENCY },
    () => new AbortController(),
  );
  const busy = controllers.map((c) => renderPDFCover("/slow.pdf", c.signal));
  const next = renderPDFCover("/ok.pdf", signal());
  await vi.waitFor(() => expect(pdf.open).toBe(PDF_COVER_CONCURRENCY));
  controllers[0].abort();
  await vi.waitFor(() => expect(pdf.closing).toHaveLength(1));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  // Still closing: the waiting file is not opened beside it.
  expect(pdf.options.filter((o) => o.url === "/ok.pdf")).toHaveLength(0);
  expect(pdf.open).toBe(PDF_COVER_CONCURRENCY);
  pdf.closing.shift()!();
  await vi.waitFor(() => expect(pdf.closing).toHaveLength(1));
  pdf.closing.shift()!();
  expect(await next).toBeInstanceOf(Blob);
  expect(pdf.peak).toBe(PDF_COVER_CONCURRENCY);
  // Cancel and cleanup ask PDF.js to close each file once.
  controllers[1].abort();
  await vi.waitFor(() => expect(pdf.closing).toHaveLength(1));
  pdf.closing.shift()!();
  await Promise.all(busy);
  expect(pdf.destroyCalls).toBe(3);
  expect(pdf.open).toBe(0);
});

it("frees the canvas and file when drawing the page fails", async () => {
  pdf.files.set("/broken.pdf", { width: 600, height: 800, broken: true });
  expect(await renderPDFCover("/broken.pdf", signal())).toBeUndefined();
  const canvas = pdf.renders[0].params.canvas as HTMLCanvasElement;
  expect([canvas.width, canvas.height]).toEqual([0, 0]);
  expect(pdf.open).toBe(0);
});
