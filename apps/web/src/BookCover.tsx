import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, FileText } from "lucide-react";
import type { Document } from "@reader/core";
import { publicationURL } from "@reader/api";
import { Button } from "@reader/ui/components/button";
import { coverResource } from "./epub-cover";

/**
 * A book's own cover when its EPUB has one, over the text cover that stays
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
  const wanted = doc.type === "epub";
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const load = () =>
      fetch(publicationURL(doc.id, "manifest.json"), {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((manifest) => {
          const resource = coverResource(manifest);
          if (resource && !controller.signal.aborted)
            setCover({ id: doc.id, src: publicationURL(doc.id, resource) });
        })
        // No cover, or an unreadable manifest: the text cover stays.
        .catch(() => {});
    // Read the manifest once the card is about to be seen.
    const element = button.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      void load();
      return () => controller.abort();
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
      controller.abort();
    };
  }, [doc.id, wanted]);
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
