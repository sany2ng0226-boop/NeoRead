import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, FileText } from "lucide-react";
import type { Document } from "@reader/core";
import { publicationURL } from "@reader/api";
import { Button } from "@reader/ui/components/button";
import { coverResource } from "./epub-cover";

/**
 * An EPUB's own cover or a PDF's first page, over the text cover that stays
 * in place while it loads and whenever there is none or it fails. Grid and
 * list show the same card, so changing views keeps what has been loaded.
 */
export function BookCover({
  document: doc,
  index,
  onOpen,
}: {
  document: Document;
  index: number;
  onOpen: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  // Keyed by document, so a reused card never shows another book's cover.
  const [cover, setCover] = useState<{ id: string; src: string }>();
  const [loaded, setLoaded] = useState("");
  const wanted = doc.type === "epub" || doc.type === "pdf";
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    // The drawn first page of a PDF lives only as long as this card shows it.
    let drawn = "";
    const loadEPUB = () =>
      fetch(publicationURL(doc.id, "manifest.json"), {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((manifest) => {
          const resource = coverResource(manifest);
          if (resource && !controller.signal.aborted)
            setCover({ id: doc.id, src: publicationURL(doc.id, resource) });
        });
    const loadPDF = async () => {
      const { renderPDFCover } = await import("./pdf-cover");
      const blob = await renderPDFCover(
        publicationURL(doc.id, "original.pdf"),
        controller.signal,
      );
      if (!blob || controller.signal.aborted) return;
      drawn = URL.createObjectURL(blob);
      setCover({ id: doc.id, src: drawn });
    };
    const load = () =>
      (doc.type === "pdf" ? loadPDF() : loadEPUB())
        // No cover, or an unreadable file: the text cover stays.
        .catch(() => {});
    // Large shelves would otherwise read every manifest or PDF at once.
    const element = button.current;
    const cleanup = () => {
      controller.abort();
      if (drawn) URL.revokeObjectURL(drawn);
    };
    if (!element || typeof IntersectionObserver === "undefined") {
      void load();
      return cleanup;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      cleanup();
    };
  }, [doc.id, doc.type, wanted]);
  const src = wanted && cover?.id === doc.id ? cover.src : undefined;
  return (
    <Button
      ref={button}
      variant="ghost"
      title={doc.title}
      aria-label={`打开 ${doc.title}`}
      className={`book-cover cover-${index % 4}`}
      data-image={(src && loaded === src) || undefined}
      onClick={onOpen}
    >
      <div className="cover-top">
        <span>{doc.type.toUpperCase()}</span>
        {doc.type === "epub" ? <BookOpen size={18} /> : <FileText size={18} />}
      </div>
      <div className="cover-text">
        <div className="cover-title">{doc.title}</div>
        {doc.author && (
          <div className="cover-author" title={doc.author}>
            {doc.author}
          </div>
        )}
      </div>
      <div className="cover-bottom">
        <ArrowUpRight size={18} />
      </div>
      <div className="cover-decoration" />
      {src && (
        <img
          key={src}
          className="cover-image"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(src)}
          onError={() => setCover(undefined)}
        />
      )}
    </Button>
  );
}
