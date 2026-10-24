// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@reader/core";
import { BookCover } from "./BookCover";
import { paper } from "./papers/fixtures";

vi.mock("@reader/api", () => ({
  publicationURL: (id: string, resource: string) =>
    `/pub/session/${id}/${resource}`,
}));

const book = (id: string, patch: Partial<Document> = {}) =>
  paper({ id, title: `书 ${id}`, type: "epub", library: "books", ...patch });
const manifest = (href: string) => ({
  resources: [{ href, rel: "cover", type: "image/jpeg" }],
});
let root: Root, host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const pending = new Map<
  string,
  { resolve: (body: unknown) => void; signal: AbortSignal }
>();
const render = (doc: Document) =>
  act(async () =>
    root.render(<BookCover document={doc} index={0} onOpen={() => {}} />),
  );
const answer = (id: string, body: unknown) =>
  act(async () => pending.get(id)!.resolve(body));
const cover = () => host.querySelector<HTMLButtonElement>(".book-cover")!;
const image = () => host.querySelector<HTMLImageElement>(".cover-image");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn(
    (url: string, init: RequestInit) =>
      new Promise((resolve) => {
        const id = url.split("/")[3];
        pending.set(id, {
          signal: init.signal!,
          resolve: (body) =>
            resolve(
              body === 404
                ? new Response("", { status: 404 })
                : Response.json(body),
            ),
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  pending.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows the book's own cover once it has loaded, keeping the text cover until then", async () => {
  await render(book("a"));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe("/pub/session/a/manifest.json");
  await answer("a", manifest("OEBPS/Images/封 面.jpg"));
  expect(image()!.getAttribute("src")).toBe(
    `/pub/session/a/OEBPS/Images/${encodeURIComponent("封 面")}.jpg`,
  );
  expect(image()!.alt).toBe("");
  expect(image()!.getAttribute("loading")).toBe("lazy");
  expect(cover().dataset.image).toBeUndefined();
  expect(cover().getAttribute("aria-label")).toBe("打开 书 a");
  await act(async () => image()!.dispatchEvent(new Event("load")));
  expect(cover().dataset.image).toBe("true");
  // Re-rendering the same book does not ask again.
  await render(book("a", { percentage: 0.5 }));
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("falls back to the text cover for missing, failed or broken covers", async () => {
  await render(book("none"));
  await answer("none", { resources: [{ href: "x.css", type: "text/css" }] });
  expect(image()).toBeNull();

  await act(async () => root.render(null));
  await render(book("gone"));
  await answer("gone", 404);
  expect(image()).toBeNull();

  await act(async () => root.render(null));
  await render(book("unsafe"));
  await answer("unsafe", manifest("https://example.test/c.jpg"));
  expect(image()).toBeNull();

  await act(async () => root.render(null));
  await render(book("broken"));
  await answer("broken", manifest("c.jpg"));
  await act(async () => image()!.dispatchEvent(new Event("error")));
  expect(image()).toBeNull();
  expect(cover().dataset.image).toBeUndefined();
  expect(host.querySelector(".cover-title")!.textContent).toBe("书 broken");
});

it("never asks for an EPUB manifest for PDFs", async () => {
  await render(book("pdf", { type: "pdf" }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(image()).toBeNull();
});

it("cancels a pending manifest and never shows it on another book", async () => {
  await render(book("first"));
  const first = pending.get("first")!;
  await render(book("second"));
  expect(first.signal.aborted).toBe(true);
  await answer("first", manifest("first.jpg"));
  expect(image()).toBeNull();
  await answer("second", manifest("second.jpg"));
  expect(image()!.getAttribute("src")).toBe("/pub/session/second/second.jpg");
  // Switching back hides the second book's cover until the first one's loads.
  await render(book("first"));
  expect(image()).toBeNull();
});
