import { type MatchThresholds, bestMatch, bookIsbns, isbn13Of } from '../book-match';
import { PacedHttp, type PacedHttpOptions, readJson } from '../paced-http';
import {
  type BookRef,
  type RatingLookup,
  type RatingSourceAdapter,
  ratingValue,
} from '../rating-source';
import { SourceError } from '../source-error';

export const GOOGLE_BOOKS_KEY = 'google_books';

export interface GoogleBooksOptions extends PacedHttpOptions, MatchThresholds {
  /** GOOGLE_BOOKS_ENABLED (off by default, D-020). */
  enabled: boolean;
  /** GOOGLE_BOOKS_API_KEY; without it the source is not asked (anonymous calls get 429). */
  apiKey: string | undefined;
  maxResults: number;
  baseUrl?: string;
}

const FIELDS =
  'items(id,volumeInfo(title,subtitle,authors,industryIdentifiers,averageRating,ratingsCount))';

interface Volume {
  id: string;
  titles: string[];
  authors: string[];
  isbns: string[];
  averageRating: number | null;
  ratingsCount: number;
}

/**
 * Google Books ratings (D-003 "live only", D-020). Ratings belong to one
 * volume, so only the volume with this edition's ISBN is used
 * (`ratingScope: edition`; D-013: no borrowing from other editions). Field
 * searches (`isbn:`) are unreliable, so an ISBN search is tried first and a
 * plain title search second; either way the ISBN, title and author are checked
 * in code. A missing rating is no data, never a low score.
 *
 * Terms forbid permanent copies: the result carries the HTTP cache lifetime,
 * and the caller keeps it no longer. The API key is a URL parameter, so URLs
 * are never logged or put in error messages.
 */
export class GoogleBooksRatings implements RatingSourceAdapter {
  readonly key = GOOGLE_BOOKS_KEY;
  readonly configured: boolean;
  private readonly http: PacedHttp;

  constructor(private readonly options: GoogleBooksOptions) {
    this.configured = options.enabled && !!options.apiKey;
    this.http = new PacedHttp(options);
  }

  async lookup(book: BookRef, signal: AbortSignal): Promise<RatingLookup> {
    const isbns = bookIsbns(book);
    if (isbns.length === 0) return { outcome: 'empty', reason: 'no_isbn' };

    let cacheMaxAgeSeconds: number | null = null;
    for (const q of [`isbn:${isbns[0]}`, book.title]) {
      const { volumes, maxAge } = await this.search(q, signal);
      cacheMaxAgeSeconds = minAge(cacheMaxAgeSeconds, maxAge);
      const sameEdition = volumes.filter((v) => v.isbns.some((i) => isbns.includes(i)));
      const top = bestMatch(book, sameEdition, (v) => v, this.options);
      if (!top) continue;
      const v = top.candidate;
      if (v.averageRating === null || v.ratingsCount === 0)
        return { outcome: 'empty', reason: 'no_ratings', externalId: v.id };
      return {
        outcome: 'ok',
        ratingAverage: ratingValue(v.averageRating),
        ratingCount: v.ratingsCount,
        ratingScope: 'edition',
        externalId: v.id,
        matchedBy: 'isbn',
        cacheMaxAgeSeconds,
      };
    }
    return { outcome: 'empty', reason: 'not_found' };
  }

  private async search(
    q: string,
    signal: AbortSignal,
  ): Promise<{ volumes: Volume[]; maxAge: number | null }> {
    const url = new URL('/books/v1/volumes', this.options.baseUrl ?? 'https://www.googleapis.com');
    url.searchParams.set('q', q);
    url.searchParams.set('maxResults', String(this.options.maxResults));
    url.searchParams.set('printType', 'books');
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('key', this.options.apiKey ?? '');
    const response = await this.http.send(url, { headers: { Accept: 'application/json' } }, signal);
    if (!response.ok) throw await failure(response);
    const body = (await readJson(response)) as { items?: unknown } | null;
    if (body === null || typeof body !== 'object')
      throw new SourceError('failed', 'Unexpected response shape', 'bad_response');
    // No `items` is how Google says "no results".
    if (body.items === undefined) return { volumes: [], maxAge: maxAgeOf(response) };
    if (!Array.isArray(body.items))
      throw new SourceError('failed', 'Unexpected response shape', 'bad_response');
    return {
      volumes: body.items.map(parseVolume).filter((v): v is Volume => v !== null),
      maxAge: maxAgeOf(response),
    };
  }
}

async function failure(response: Response): Promise<SourceError> {
  let reason = '';
  try {
    const body = (await response.json()) as {
      error?: { errors?: Array<{ reason?: unknown }>; message?: unknown };
    };
    reason = String(body.error?.errors?.[0]?.reason ?? '');
    if (/api key not valid/i.test(String(body.error?.message ?? ''))) reason = 'keyInvalid';
  } catch {
    // Body is not needed to classify the failure.
  }
  // 403 with a quota reason is a rate limit, not a broken source.
  if (response.status === 403 && /rateLimit|quota|dailyLimit|userRateLimit/i.test(reason))
    return new SourceError('rate_limited', `HTTP 403 (${reason})`);
  if (
    reason === 'keyInvalid' ||
    (response.status === 403 && /forbidden|accessNotConfigured/i.test(reason))
  )
    return new SourceError('failed', 'API key refused', 'unauthorized');
  return new SourceError('failed', `HTTP ${response.status}`, `http_${response.status}`);
}

/** `Cache-Control: max-age`, or null when the header is missing (Google sent none on 2026-10-21). */
export function maxAgeOf(response: Response): number | null {
  const header = response.headers.get('cache-control') ?? '';
  if (/no-store|no-cache/i.test(header)) return 0;
  const match = /max-age=(\d+)/i.exec(header);
  return match ? Number(match[1]) : null;
}

function minAge(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function parseVolume(value: unknown): Volume | null {
  const item = value as { id?: unknown; volumeInfo?: Record<string, unknown> } | null;
  const info = item?.volumeInfo;
  const title = typeof info?.title === 'string' ? info.title.slice(0, 500) : null;
  if (!item || typeof item.id !== 'string' || !info || !title) return null;
  const ids = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
  const isbns = ids
    .filter(
      (i: { type?: unknown; identifier?: unknown } | null) =>
        (i?.type === 'ISBN_13' || i?.type === 'ISBN_10') && typeof i.identifier === 'string',
    )
    .map((i: { identifier: string }) => isbn13Of(i.identifier))
    .filter((i): i is string => i !== null);
  const subtitle = typeof info.subtitle === 'string' ? info.subtitle.slice(0, 500) : null;
  const average = info.averageRating;
  const count = info.ratingsCount;
  return {
    id: item.id.slice(0, 100),
    titles: subtitle ? [title, `${title}: ${subtitle}`] : [title],
    authors: Array.isArray(info.authors)
      ? info.authors.filter((a): a is string => typeof a === 'string').slice(0, 10)
      : [],
    isbns,
    averageRating:
      typeof average === 'number' && Number.isFinite(average) && average > 0 ? average : null,
    ratingsCount: typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0,
  };
}
