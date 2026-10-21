import { normalizeForSearch } from '../catalog/normalize';

/**
 * Decides, in code, whether a book a live source returned is the reader's
 * book (D-020). Sources' searches are fuzzy (Hardcover always returns
 * something) and even an ISBN lookup can return another book (Open Library),
 * so every candidate needs a title and an author match.
 *
 * Similarity is trigram similarity computed like PostgreSQL's pg_trgm, so the
 * numbers mean the same as the catalog search thresholds.
 */

export interface MatchThresholds {
  /** SOURCE_MATCH_MIN_TITLE */
  minTitle: number;
  /** SOURCE_MATCH_MIN_AUTHOR */
  minAuthor: number;
}

export interface BookToMatch {
  title: string;
  subtitle?: string | null;
  authors: string[];
  isbn13: string | null;
  isbn10: string | null;
}

export interface CandidateToMatch {
  /** Every title the source gives (main, edition, alternative titles). */
  titles: string[];
  authors: string[];
  isbns: string[];
}

export interface MatchResult {
  titleScore: number;
  authorScore: number;
  isbnMatch: boolean;
  /** For ranking several matches: higher is better. */
  score: number;
}

function trigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of normalizeForSearch(text).split(' ')) {
    if (word === '') continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) result.add(padded.slice(i, i + 3));
  }
  return result;
}

/** pg_trgm `similarity(a, b)`: shared trigrams over all trigrams, 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * A title with and without its subtitle, bracketed series marker and
 * alternative title ("The Hobbit, or There and Back Again", "Frankenstein;
 * or, The Modern Prometheus").
 */
export function titleForms(title: string): string[] {
  const forms = new Set<string>([title]);
  const unbracketed = title.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
  if (unbracketed) forms.add(unbracketed);
  const main = unbracketed.split(/[:;]\s|,\s+or\b/i)[0]?.trim();
  if (main) forms.add(main);
  return [...forms];
}

function best(as: string[], bs: string[]): number {
  let top = 0;
  for (const a of as) for (const b of bs) top = Math.max(top, similarity(a, b));
  return top;
}

/** ISBN-10 to ISBN-13 (978 prefix), or null if it is not a valid ISBN-10 shape. */
export function isbn13Of(isbn: string): string | null {
  const clean = isbn.replace(/[^\dX]/gi, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(clean)) return clean;
  if (!/^\d{9}[\dX]$/.test(clean)) return null;
  const body = `978${clean.slice(0, 9)}`;
  const sum = [...body].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** The book's ISBNs as ISBN-13s, without duplicates. */
export function bookIsbns(book: Pick<BookToMatch, 'isbn13' | 'isbn10'>): string[] {
  const all = [book.isbn13, book.isbn10]
    .filter((i): i is string => !!i)
    .map(isbn13Of)
    .filter((i): i is string => !!i);
  return [...new Set(all)];
}

/**
 * Null when the candidate is not this book. A book without authors in the
 * catalog matches on title alone; a candidate without authors never matches
 * a book that has them (it cannot be checked).
 */
export function matchBook(
  book: BookToMatch,
  candidate: CandidateToMatch,
  t: MatchThresholds,
): MatchResult | null {
  const bookTitles = titleForms(book.title);
  if (book.subtitle) bookTitles.push(`${book.title}: ${book.subtitle}`);
  const candidateTitles = candidate.titles.flatMap(titleForms);
  const titleScore = best(bookTitles, candidateTitles);
  if (titleScore < t.minTitle) return null;

  let authorScore = 1;
  if (book.authors.length > 0) {
    authorScore = best(book.authors, candidate.authors);
    if (authorScore < t.minAuthor) return null;
  }
  const ours = new Set(bookIsbns(book));
  const isbnMatch = candidate.isbns.some((i) => {
    const as13 = isbn13Of(i);
    return as13 !== null && ours.has(as13);
  });
  return {
    titleScore,
    authorScore,
    isbnMatch,
    score: titleScore + authorScore + (isbnMatch ? 1 : 0),
  };
}

/** The best-matching candidate, or null when none is this book. */
export function bestMatch<C>(
  book: BookToMatch,
  candidates: C[],
  view: (candidate: C) => CandidateToMatch,
  t: MatchThresholds,
): { candidate: C; match: MatchResult } | null {
  let top: { candidate: C; match: MatchResult } | null = null;
  for (const candidate of candidates) {
    const match = matchBook(book, view(candidate), t);
    if (match && (!top || match.score > top.match.score)) top = { candidate, match };
  }
  return top;
}
