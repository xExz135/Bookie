import { deterministicUuid } from '../../common/deterministic-id';
import { toBcp47 } from '../language';
import { cleanText, normalizeForSearch } from '../normalize';

/**
 * Pure mapping from UCSD Goodreads Book Graph records to Bookie rows.
 * No I/O here, so every rule is unit-tested.
 */

export const ids = {
  book: (bookId: string) => deterministicUuid(`goodreads:book:${bookId}`),
  work: (workId: string) => deterministicUuid(`goodreads:work:${workId}`),
  /** A work made for a book whose work is missing from the works file. */
  placeholderWork: (bookId: string) => deterministicUuid(`goodreads:book-work:${bookId}`),
  author: (authorId: string) => deterministicUuid(`goodreads:author:${authorId}`),
  review: (reviewId: string) => deterministicUuid(`goodreads:review:${reviewId}`),
  ratingSummary: (bookId: string) => deterministicUuid(`goodreads:rating-summary:${bookId}`),
};

export interface RawAuthor {
  author_id?: string;
  name?: string;
}

export interface RawWork {
  work_id?: string;
  original_title?: string;
  original_publication_year?: string;
}

export interface RawBook {
  book_id?: string;
  work_id?: string;
  title?: string;
  title_without_series?: string;
  authors?: Array<{ author_id?: string; role?: string }>;
  language_code?: string;
  publisher?: string;
  publication_year?: string;
  format?: string;
  num_pages?: string;
  isbn?: string;
  isbn13?: string;
  image_url?: string;
  description?: string;
  average_rating?: string;
  ratings_count?: string;
}

export interface RawGenres {
  book_id?: string;
  genres?: Record<string, number>;
}

export interface RawReview {
  review_id?: string;
  book_id?: string;
  user_id?: string;
  rating?: number;
  review_text?: string;
  date_added?: string;
}

export interface AuthorRow {
  id: string;
  externalId: string;
  name: string;
  normalizedName: string;
}

export interface WorkRow {
  id: string;
  /** Null for placeholder works. */
  externalId: string | null;
  title: string;
  originalPublicationYear: number | null;
}

export interface BookRow {
  externalId: string;
  workExternalId: string | null;
  edition: {
    id: string;
    title: string;
    language: string | null;
    publisher: string | null;
    publicationYear: number | null;
    format: string | null;
    pageCount: number | null;
    isbn10: string | null;
    isbn13: string | null;
    coverUrl: string | null;
    description: string | null;
    normalizedTitle: string;
  };
  authors: Array<{ externalId: string; position: number; role: string | null }>;
  /** Goodreads' own rating summary for the edition, when it has ratings. */
  ratingSummary: { id: string; average: number; count: number } | null;
}

export interface ReviewRow {
  id: string;
  bookExternalId: string;
  externalReviewId: string;
  reviewerExternalId: string | null;
  rating: number | null;
  text: string;
  textLength: number;
  postedAt: Date | null;
}

function intInRange(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function isbn(value: unknown, length: 10 | 13): string | null {
  const cleaned = cleanText(value)?.replace(/[-\s]/g, '').toUpperCase() ?? null;
  if (!cleaned) return null;
  const pattern = length === 10 ? /^\d{9}[\dX]$/ : /^\d{13}$/;
  return pattern.test(cleaned) ? cleaned : null;
}

export function parseAuthor(raw: RawAuthor): AuthorRow | null {
  const externalId = cleanText(raw.author_id);
  const name = cleanText(raw.name);
  if (!externalId || !name) return null;
  return { id: ids.author(externalId), externalId, name, normalizedName: normalizeForSearch(name) };
}

export function parseWork(raw: RawWork): WorkRow | null {
  const externalId = cleanText(raw.work_id);
  const title = cleanText(raw.original_title);
  if (!externalId || !title) return null;
  return {
    id: ids.work(externalId),
    externalId,
    title,
    originalPublicationYear: intInRange(raw.original_publication_year, -3000, 2100),
  };
}

/**
 * Removes a trailing series marker such as "(The Hunger Games, #1)",
 * "(Discworld, #1.5)" or "(Sun Wolf and Starhawk, #1-2)". The dataset's
 * `title_without_series` field still contains it, so this is done here.
 */
export function stripSeriesMarker(title: string): string {
  const stripped = title
    .replace(/\s*\((?:[^()]|\([^()]*\))*#\s*\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\)\s*$/u, '')
    .trim();
  return stripped === '' ? title : stripped;
}

export function parseBook(raw: RawBook): BookRow | null {
  const externalId = cleanText(raw.book_id);
  const fullTitle = cleanText(raw.title_without_series) ?? cleanText(raw.title);
  const title = fullTitle ? stripSeriesMarker(fullTitle) : null;
  if (!externalId || !title) return null;

  const coverUrl = cleanText(raw.image_url);
  const seen = new Set<string>();
  const authors: BookRow['authors'] = [];
  for (const author of raw.authors ?? []) {
    const authorId = cleanText(author.author_id);
    if (!authorId || seen.has(authorId)) continue;
    seen.add(authorId);
    authors.push({
      externalId: authorId,
      position: authors.length + 1,
      role: cleanText(author.role),
    });
  }

  const average = Number.parseFloat(raw.average_rating ?? '');
  const count = intInRange(raw.ratings_count, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const ratingSummary =
    count > 0 && average >= 1 && average <= 5
      ? { id: ids.ratingSummary(externalId), average: Math.round(average * 100) / 100, count }
      : null;

  return {
    externalId,
    workExternalId: cleanText(raw.work_id),
    edition: {
      id: ids.book(externalId),
      title,
      language: toBcp47(raw.language_code),
      publisher: cleanText(raw.publisher),
      publicationYear: intInRange(raw.publication_year, 1400, 2100),
      format: cleanText(raw.format),
      pageCount: intInRange(raw.num_pages, 1, 100_000),
      isbn10: isbn(raw.isbn, 10),
      isbn13: isbn(raw.isbn13, 13),
      // Goodreads uses a "nophoto" placeholder image for books without a cover.
      coverUrl: coverUrl && !coverUrl.includes('nophoto') ? coverUrl : null,
      description: cleanText(raw.description),
      normalizedTitle: normalizeForSearch(title),
    },
    authors,
    ratingSummary,
  };
}

export function parseGenres(
  raw: RawGenres,
): Array<{ bookExternalId: string; genre: string; votes: number }> {
  const bookExternalId = cleanText(raw.book_id);
  if (!bookExternalId || !raw.genres) return [];
  return Object.entries(raw.genres)
    .filter(([, votes]) => Number.isInteger(votes) && votes >= 0)
    .map(([genre, votes]) => ({ bookExternalId, genre, votes }));
}

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/** Parses Goodreads dates like "Fri Aug 25 13:55:02 -0700 2017". */
export function parseGoodreadsDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, mon, day, hh, mi, ss, sign, tzh, tzm, year] = m;
  const month = MONTHS[mon!];
  if (!month) return null;
  const date = new Date(
    `${year}-${month}-${day!.padStart(2, '0')}T${hh}:${mi}:${ss}${sign}${tzh}:${tzm}`,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A dataset review. Rating 0 means "no rating". A review with neither a
 * rating nor text carries no evidence and is skipped (returns null).
 */
export function parseReview(raw: RawReview): ReviewRow | null {
  const externalReviewId = cleanText(raw.review_id);
  const bookExternalId = cleanText(raw.book_id);
  if (!externalReviewId || !bookExternalId) return null;
  const rating = intInRange(raw.rating, 1, 5);
  const text = cleanText(raw.review_text) ?? '';
  if (rating === null && text === '') return null;
  return {
    id: ids.review(externalReviewId),
    bookExternalId,
    externalReviewId,
    reviewerExternalId: cleanText(raw.user_id),
    rating,
    text,
    textLength: text.length,
    postedAt: parseGoodreadsDate(raw.date_added),
  };
}
