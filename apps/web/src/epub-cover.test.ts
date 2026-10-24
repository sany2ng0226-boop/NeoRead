import { expect, it } from "vitest";
import { bookResource, coverResource } from "./epub-cover";

it("keeps book paths inside the book, encoded once per segment", () => {
  expect(bookResource("OEBPS/Images/cover.jpg")).toBe("OEBPS/Images/cover.jpg");
  expect(bookResource("Images/my cover.jpg")).toBe("Images/my%20cover.jpg");
  expect(bookResource("Images/my%20cover.jpg")).toBe("Images/my%20cover.jpg");
  expect(bookResource("图片/封面 1.jpeg")).toBe(
    `${encodeURIComponent("图片")}/${encodeURIComponent("封面 1.jpeg")}`,
  );
  expect(bookResource("%E5%9B%BE/%E5%B0%81%E9%9D%A2.jpg")).toBe(
    "%E5%9B%BE/%E5%B0%81%E9%9D%A2.jpg",
  );
  expect(bookResource("Images/a%2525b.jpg")).toBe("Images/a%2525b.jpg");
  expect(bookResource("Images/c#x.jpg")).toBe("Images/c");
  expect(bookResource("cover.jpg?v=2#top")).toBe("cover.jpg");
});

it("rejects remote, inline, rooted and escaping paths", () => {
  for (const href of [
    "https://example.test/cover.jpg",
    "//example.test/cover.jpg",
    "data:image/jpeg;base64,AAAA",
    "blob:http://127.0.0.1/1",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "/api/documents",
    "/pub/token/other/cover.jpg",
    "../other/cover.jpg",
    "Images/../../cover.jpg",
    "Images/./cover.jpg",
    "Images//cover.jpg",
    "Images/%2e%2e/%2E%2E/cover.jpg",
    "Images%2F..%2F..%2Fcover.jpg",
    "Images%5Ccover.jpg",
    "Images\\cover.jpg",
    "Images/%00cover.jpg",
    "Images/%zz.jpg",
    "",
    "?x",
    42,
    undefined,
  ])
    expect(bookResource(href), String(href)).toBeUndefined();
});

it("finds the cover image by rel string or list, never a page or SVG", () => {
  expect(
    coverResource({
      resources: [
        {
          href: "Text/cover.xhtml",
          rel: "cover",
          type: "application/xhtml+xml",
        },
        { href: "Images/cover.svg", rel: "cover", type: "image/svg+xml" },
        { href: "Images/other.jpg", type: "image/jpeg" },
        { href: "Images/封面.jpg", rel: ["cover"], type: "image/jpeg" },
      ],
    }),
  ).toBe(`Images/${encodeURIComponent("封面")}.jpg`);
  expect(
    coverResource({
      resources: [{ href: "cover.JPEG", rel: "cover", type: "image/jpeg" }],
    }),
  ).toBe("cover.JPEG");
  expect(
    coverResource({ resources: [{ href: "c.png", rel: ["x", "cover"] }] }),
  ).toBe("c.png");
  // A remote or escaping cover falls through to nothing.
  expect(
    coverResource({
      resources: [
        {
          href: "https://example.test/c.jpg",
          rel: "cover",
          type: "image/jpeg",
        },
        { href: "../c.jpg", rel: "cover", type: "image/jpeg" },
        { href: "cover.html", rel: "cover", type: "image/jpeg" },
        { href: "c.jpg", rel: "cover", type: "text/html" },
      ],
    }),
  ).toBeUndefined();
  for (const manifest of [
    null,
    "x",
    {},
    { resources: "x" },
    { resources: [null] },
  ])
    expect(coverResource(manifest)).toBeUndefined();
});
