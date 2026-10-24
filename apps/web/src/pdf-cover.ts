import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** The largest cover drawn, in CSS pixels; covers on the shelf are smaller. */
export const PDF_COVER_BOX = { width: 240, height: 320 };
/** At most this many PDFs open at once while the shelf draws first pages. */
export const PDF_COVER_CONCURRENCY = 2;
// A PDF that never finishes loading must not hold a drawing slot forever.
const TIME_LIMIT = 20_000;

type PDFJS = Pick<
  typeof import("pdfjs-dist"),
  "getDocument" | "AnnotationMode"
>;

/** A cover drawer sharing one bounded set of drawing slots. */
export function pdfCoverRenderer(load: () => Promise<PDFJS>) {
  // A permit is handed straight to the next waiter on release, so a slot is
  // never free while someone queues; a waiter canceled after being granted
  // passes its permit on instead of dropping it.
  let free = PDF_COVER_CONCURRENCY;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };
  async function slot(signal: AbortSignal) {
    signal.throwIfAborted();
    if (free > 0) {
      free--;
      return release;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
    if (signal.aborted) {
      release();
      throw signal.reason;
    }
    return release;
  }
  /**
   * Draws the first page of a PDF as a cover image, or returns undefined when
   * the file is missing, damaged, protected, or the work was canceled.
   * Only the first page is requested and drawn; nothing else is kept.
   */
  return async function draw(
    url: string,
    signal: AbortSignal,
  ): Promise<Blob | undefined> {
    let done: (() => void) | undefined;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    let drawing: import("pdfjs-dist").RenderTask | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let closing: Promise<void> | undefined;
    // PDF.js tears its worker down asynchronously; one request, awaited
    // before the slot is released so closing files still count.
    const close = () =>
      task ? (closing ??= task.destroy().catch(() => {})) : Promise.resolve();
    const local = new AbortController();
    const stop = () => local.abort();
    local.signal.addEventListener("abort", () => {
      drawing?.cancel();
      void close();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener("abort", stop, { once: true });
    try {
      done = await slot(signal);
      // Time spent waiting for a slot does not count against the limit.
      timer = setTimeout(stop, TIME_LIMIT);
      const pdfjs = await load();
      local.signal.throwIfAborted();
      task = pdfjs.getDocument({
        url,
        // Read only the byte ranges the first page needs.
        disableAutoFetch: true,
        disableStream: true,
        cMapUrl: "/pdf-assets/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdf-assets/standard_fonts/",
        wasmUrl: "/pdf-assets/wasm/",
      });
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      local.signal.throwIfAborted();
      // The page's own /Rotate is applied by the default viewport.
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
      const scale =
        Math.min(
          PDF_COVER_BOX.width / base.width,
          PDF_COVER_BOX.height / base.height,
        ) * ratio;
      const viewport = page.getViewport({ scale });
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) return;
      drawing = page.render({
        canvas,
        canvasContext: context,
        viewport,
        background: "#ffffff",
        // Forms and widgets are interactive content, not the page.
        annotationMode: pdfjs.AnnotationMode.DISABLE,
      });
      await drawing.promise;
      drawing = undefined;
      local.signal.throwIfAborted();
      const drawn = canvas;
      const blob = await new Promise<Blob | null>((resolve) =>
        drawn.toBlob(resolve, "image/png"),
      );
      return local.signal.aborted ? undefined : (blob ?? undefined);
    } catch {
      return;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      drawing?.cancel();
      if (canvas) canvas.width = canvas.height = 0;
      await close();
      done?.();
    }
  };
}

/** Loads PDF.js on demand, so the shelf does not carry it until needed. */
export const renderPDFCover = pdfCoverRenderer(async () => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= workerURL;
  return pdfjs;
});
