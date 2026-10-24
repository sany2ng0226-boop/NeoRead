/** Fallback for books without a language; accented prose keeps the book's defaults. */
export function chapterLanguage(text: string): "zh" | "en" | undefined {
  const sample = text.slice(0, 4000);
  const cjk = sample.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  const ascii = sample.match(/[A-Za-z]/g)?.length ?? 0;
  const accented = sample.match(/[À-ɏ]/g)?.length ?? 0;
  if (cjk >= 20 && cjk >= ascii / 4) return "zh";
  if (ascii >= 200 && cjk < 5 && accented * 50 < ascii) return "en";
  return undefined;
}
