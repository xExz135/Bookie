/**
 * Search form of a title or name: accents stripped, lowercased, punctuation
 * turned into single spaces. Used for the trigram indexes and fuzzy matching
 * (spec 6: "queries are normalized and fuzzy-matched").
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Trims, removes NUL characters PostgreSQL cannot store, and turns '' into null. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\u0000/g, '').trim();
  return cleaned === '' ? null : cleaned;
}
