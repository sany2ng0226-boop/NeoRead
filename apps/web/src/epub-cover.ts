const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const extensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);

/**
 * The publication path of a manifest href, encoded again segment by segment,
 * or undefined unless it names a file inside this book. Manifest hrefs are
 * book content: they may not leave the book, carry a scheme, start at the
 * root, or hide separators and dot segments behind percent-encoding.
 */
export function bookResource(href: unknown) {
  if (typeof href !== "string") return;
  const path = href.split(/[?#]/)[0];
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  )
    return;
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return;
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[/\\]/.test(segment) ||
      [...segment].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return;
    segments.push(encodeURIComponent(segment));
  }
  return segments.join("/");
}

type Link = { href?: unknown; type?: unknown; rel?: unknown };

/** The book's own cover image, as a publication path, from its manifest. */
export function coverResource(manifest: unknown) {
  if (!manifest || typeof manifest !== "object") return;
  const { resources, readingOrder } = manifest as {
    resources?: unknown;
    readingOrder?: unknown;
  };
  for (const list of [resources, readingOrder]) {
    if (!Array.isArray(list)) continue;
    for (const link of list as Link[]) {
      if (!link || typeof link !== "object") continue;
      const rel = Array.isArray(link.rel) ? link.rel : [link.rel];
      if (!rel.includes("cover")) continue;
      const path = bookResource(link.href);
      const extension = path?.split(".").pop()?.toLowerCase() ?? "";
      const type =
        typeof link.type === "string"
          ? link.type.split(";")[0].trim().toLowerCase()
          : "";
      // Only raster images; never an XHTML cover page or SVG.
      if (path && extensions.has(extension) && (!type || imageTypes.has(type)))
        return path;
    }
  }
}
