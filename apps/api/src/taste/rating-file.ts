import { stripSeriesMarker } from '../catalog/goodreads/parse';
import { parseCsv } from './csv';

/**
 * Reads a rating export in memory (spec 5, spec 12: "parse imported files in
 * memory and keep only the ratings"). Only title, author, rating and the IDs
 * used for matching are taken; reviews, notes, shelves and dates are never
 * read into the result.
 */
export type FileFormat = 'goodreads' | 'storygraph';

export interface RatingRow {
  /** 1-based position among the rated rows, shown to the reader. */
  rowIndex: number;
  title: string;
  author: string | null;
  /** 1 to 5. */
  rating: number;
  /** Goodreads only: the Goodreads book id, the same id the dataset uses. */
  goodreadsBookId: string | null;
  isbn13: string | null;
  isbn10: string | null;
}

export type ParseResult =
  | { ok: true; format: FileFormat; rows: RatingRow[]; ignored: number }
  | { ok: false; reason: 'not_text' | 'unknown_format' | 'no_ratings' | 'too_many_rows' };

const GOODREADS_COLUMNS = ['Book Id', 'Title', 'Author', 'My Rating'];
const STORYGRAPH_COLUMNS = ['Title', 'Authors', 'Star Rating'];
const MAX_TEXT = 500;

export function parseRatingFile(data: Buffer, maxRows: number): ParseResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return { ok: false, reason: 'not_text' };
  }
  if (text.includes('\u0000')) return { ok: false, reason: 'not_text' };

  // Header plus a margin for unrated rows; the rated-row limit is checked below.
  const records = parseCsv(text, maxRows * 20 + 1);
  const header = (records[0] ?? []).map((h) => h.trim());
  const column = (name: string) => header.indexOf(name);
  const has = (names: string[]) => names.every((n) => column(n) !== -1);

  let format: FileFormat;
  if (has(GOODREADS_COLUMNS)) format = 'goodreads';
  else if (has(STORYGRAPH_COLUMNS)) format = 'storygraph';
  else return { ok: false, reason: 'unknown_format' };

  const get = (record: string[], name: string): string => {
    const i = column(name);
    return i === -1 ? '' : (record[i] ?? '').trim();
  };

  const rows: RatingRow[] = [];
  let ignored = 0;
  for (const record of records.slice(1)) {
    const rating =
      format === 'goodreads'
        ? goodreadsRating(get(record, 'My Rating'))
        : storygraphRating(get(record, 'Star Rating'));
    const rawTitle = get(record, 'Title');
    if (rating === null || rawTitle === '') {
      ignored++;
      continue;
    }
    if (rows.length >= maxRows) return { ok: false, reason: 'too_many_rows' };
    const title = clip(stripSeriesMarker(rawTitle)) || clip(rawTitle);
    if (format === 'goodreads') {
      rows.push({
        rowIndex: rows.length + 1,
        title,
        author: clip(get(record, 'Author')) || null,
        rating,
        goodreadsBookId: /^\d{1,12}$/.test(get(record, 'Book Id')) ? get(record, 'Book Id') : null,
        isbn13: isbn(get(record, 'ISBN13'), 13),
        isbn10: isbn(get(record, 'ISBN'), 10),
      });
    } else {
      // "Authors" may list several, comma-separated; the first is the main author.
      const authors = get(record, 'Authors');
      const id = get(record, 'ISBN/UID');
      rows.push({
        rowIndex: rows.length + 1,
        title,
        author: clip(authors.split(',')[0] ?? '') || null,
        rating,
        goodreadsBookId: null,
        isbn13: isbn(id, 13),
        isbn10: isbn(id, 10),
      });
    }
  }
  if (rows.length === 0) return { ok: false, reason: 'no_ratings' };
  return { ok: true, format, rows, ignored };
}

/** Goodreads "My Rating": 1 to 5, or 0 for not rated. */
function goodreadsRating(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/**
 * StoryGraph "Star Rating": 0.25 steps from 0.25 to 5, empty when not rated.
 * Rounded to the nearest whole star (halves round up), at least 1 (D-018).
 */
function storygraphRating(value: string): number | null {
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Goodreads writes ISBNs as ="0439023483"; StoryGraph writes them plain. */
function isbn(value: string, length: 10 | 13): string | null {
  const digits = value
    .replace(/^="?|"$/g, '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
  if (length === 13) return /^97[89]\d{10}$/.test(digits) ? digits : null;
  return /^\d{9}[\dX]$/.test(digits) ? digits : null;
}

function clip(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
