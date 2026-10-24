import type { Root } from "mdast";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** CommonMark leaves punctuation-final bold literal when followed by CJK text. */
export function remarkCJKStrong() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const raw = source.slice(
          child.position?.start.offset,
          child.position?.end.offset,
        );
        if (raw.includes("\\*")) return [child];
        const pattern =
          /\*\*([^*\n]*[。！？：；，、）”’])\*\*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(pattern)) {
          if (match.index! > offset)
            parts.push({
              type: "text",
              value: child.value.slice(offset, match.index),
            });
          parts.push({
            type: "strong",
            children: [{ type: "text", value: match[1] }],
          });
          offset = match.index! + match[0].length;
        }
        if (!offset) return [child];
        if (offset < child.value.length)
          parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}
