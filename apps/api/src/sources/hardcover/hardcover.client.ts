import { type MatchThresholds, bestMatch, bookIsbns } from '../book-match';
import { PacedHttp, type PacedHttpOptions, readJson } from '../paced-http';
import {
  type BookRef,
  type MatchedBy,
  type RatingLookup,
  type RatingSourceAdapter,
  ratingValue,
} from '../rating-source';
import { SourceError } from '../source-error';

export const HARDCOVER_KEY = 'hardcover';

export interface HardcoverOptions extends PacedHttpOptions, MatchThresholds {
  /** HARDCOVER_API_TOKEN; without it the source is not asked. */
  token: string | undefined;
  userAgent: string;
  searchResults: number;
  baseUrl?: string;
}

/**
 * Only aggregate fields are asked for (D-003): Hardcover's terms forbid using
 * other users' reviews or data, and its images need a DMCA policy. Numbers are
 * labelled "Hardcover" in the API (`name`). Hardcover data is never sent to a
 * language model (its terms forbid training LLMs on it).
 */
const BY_ISBN = `query BookieRatingsByIsbn($i13: String!, $i10: String!) {
  editions(where: {_or: [{isbn_13: {_eq: $i13}}, {isbn_10: {_eq: $i10}}]}, limit: 5) {
    title
    isbn_13
    isbn_10
    book { id title rating ratings_count compilation contributions(limit: 5) { author { name } } }
  }
}`;

/** Search results are one JSON blob; everything except the fields below is discarded. */
const SEARCH = `query BookieRatingsSearch($q: String!, $n: Int!) {
  search(query: $q, query_type: "Book", per_page: $n, page: 1) { results }
}`;

interface HardcoverBook {
  id: string;
  titles: string[];
  authors: string[];
  isbns: string[];
  rating: number | null;
  ratingsCount: number;
  compilation: boolean;
}

/**
 * Hardcover ratings (D-003, D-020). Ratings belong to the book, which groups
 * every edition (`ratingScope: work`). ISBN lookup first (exact), then search,
 * which is fuzzy and always returns something, so its hits are checked in
 * code. A 401 means the token was reset or expired: `failed`, never "no
 * ratings" (DATA_SOURCES.md).
 */
export class HardcoverRatings implements RatingSourceAdapter {
  readonly key = HARDCOVER_KEY;
  readonly configured: boolean;
  private readonly http: PacedHttp;
  private readonly authorization: string;

  constructor(private readonly options: HardcoverOptions) {
    this.configured = !!options.token;
    this.http = new PacedHttp(options);
    // The docs' token is shown with "Bearer " in front; accept it with or without.
    this.authorization = `Bearer ${(options.token ?? '').replace(/^Bearer\s+/i, '')}`;
  }

  async lookup(book: BookRef, signal: AbortSignal): Promise<RatingLookup> {
    const found = await this.find(book, signal);
    if (!found) return { outcome: 'empty', reason: 'not_found' };
    const { hit, matchedBy } = found;
    if (hit.ratingsCount === 0 || hit.rating === null)
      return { outcome: 'empty', reason: 'no_ratings', externalId: hit.id };
    return {
      outcome: 'ok',
      ratingAverage: ratingValue(hit.rating),
      ratingCount: hit.ratingsCount,
      ratingScope: 'work',
      externalId: hit.id,
      matchedBy,
    };
  }

  private async find(
    book: BookRef,
    signal: AbortSignal,
  ): Promise<{ hit: HardcoverBook; matchedBy: MatchedBy } | null> {
    const isbn13 = bookIsbns(book)[0];
    if (isbn13) {
      const isbn10 = book.isbn10 ?? '';
      const data = await this.query(BY_ISBN, { i13: isbn13, i10: isbn10 }, signal);
      const hit = this.pick(book, parseEditions(data));
      if (hit) return { hit, matchedBy: 'isbn' };
    }
    const q = [book.title, book.authors[0]].filter(Boolean).join(' ');
    const data = await this.query(SEARCH, { q, n: this.options.searchResults }, signal);
    const hit = this.pick(book, parseSearch(data));
    return hit ? { hit, matchedBy: 'title_author' } : null;
  }

  /**
   * Prefers books not flagged as compilations (box sets). The flag is not
   * reliable (Divergent, a single novel, is flagged), so a flagged book is
   * still used when nothing else matches; the title check keeps most box sets
   * out anyway.
   */
  private pick(book: BookRef, books: HardcoverBook[]): HardcoverBook | null {
    const view = (b: HardcoverBook) => ({ titles: b.titles, authors: b.authors, isbns: b.isbns });
    const single = bestMatch(
      book,
      books.filter((b) => !b.compilation),
      view,
      this.options,
    );
    if (single) return single.candidate;
    return (
      bestMatch(
        book,
        books.filter((b) => b.compilation),
        view,
        this.options,
      )?.candidate ?? null
    );
  }

  private async query(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(this.options.baseUrl ?? 'https://api.hardcover.app/v1/graphql');
    const response = await this.http.send(
      url,
      {
        method: 'POST',
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
          'user-agent': this.options.userAgent,
        },
        body: JSON.stringify({ query, variables }),
      },
      signal,
    );
    if (response.status === 401)
      throw new SourceError('failed', 'Token refused (HTTP 401)', 'unauthorized');
    if (!response.ok)
      throw new SourceError('failed', `HTTP ${response.status}`, `http_${response.status}`);
    const body = (await readJson(response)) as { data?: unknown; errors?: unknown } | null;
    if (Array.isArray(body?.errors) || body?.data == null)
      throw new SourceError('failed', 'GraphQL error', 'bad_response');
    return body.data;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 500) : null;
}

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value
        .map(str)
        .filter((s): s is string => s !== null)
        .slice(0, max)
    : [];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function rating(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function idOf(value: unknown): string | null {
  return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
    ? String(value)
    : null;
}

function parseEditions(data: unknown): HardcoverBook[] {
  const editions = (data as { editions?: unknown }).editions;
  if (!Array.isArray(editions))
    throw new SourceError('failed', 'Unexpected response shape', 'bad_response');
  return editions.flatMap((e: Record<string, unknown> | null) => {
    const b = (e?.book ?? null) as Record<string, unknown> | null;
    const id = idOf(b?.id);
    const title = str(b?.title);
    if (!b || !id || !title) return [];
    const contributions = Array.isArray(b.contributions) ? b.contributions : [];
    return [
      {
        id,
        titles: [title, str(e?.title)].filter((t): t is string => !!t),
        authors: strings(
          contributions.map((c: { author?: { name?: unknown } } | null) => c?.author?.name),
          10,
        ),
        isbns: [str(e?.isbn_13), str(e?.isbn_10)].filter((i): i is string => !!i),
        rating: rating(b.rating),
        ratingsCount: count(b.ratings_count),
        compilation: b.compilation === true,
      },
    ];
  });
}

function parseSearch(data: unknown): HardcoverBook[] {
  const results = (data as { search?: { results?: unknown } }).search?.results;
  let parsed = results;
  if (typeof results === 'string') {
    try {
      parsed = JSON.parse(results);
    } catch {
      throw new SourceError('failed', 'Unexpected response shape', 'bad_response');
    }
  }
  const hits = (parsed as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits))
    throw new SourceError('failed', 'Unexpected response shape', 'bad_response');
  return hits.flatMap((h: { document?: Record<string, unknown> } | null) => {
    const d = h?.document;
    const id = idOf(d?.id);
    const title = str(d?.title);
    if (!d || !id || !title) return [];
    return [
      {
        id,
        titles: [title, ...strings(d.alternative_titles, 20)],
        authors: strings(d.author_names, 10),
        isbns: strings(d.isbns, 200),
        rating: rating(d.rating),
        ratingsCount: count(d.ratings_count),
        compilation: d.compilation === true,
      },
    ];
  });
}
