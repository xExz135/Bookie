import type { BookToMatch } from './book-match';

/** What the adapters know about the reader's book. */
export interface BookRef extends BookToMatch {
  editionId: string;
  /** Open Library work key already linked in the catalog (BE-6), e.g. "OL5735363W". */
  openLibraryWorkKey: string | null;
}

/** `work` when the rating covers every edition of the book (CONTRACT 4.4). */
export type RatingScope = 'edition' | 'work';

/** How the source's book was found. */
export type MatchedBy = 'known_id' | 'isbn' | 'title_author';

export interface FoundRatings {
  outcome: 'ok';
  ratingAverage: number;
  ratingCount: number;
  ratingScope: RatingScope;
  /** The source's own ID for the book, for the check tool and logs. */
  externalId: string;
  matchedBy: MatchedBy;
  /**
   * How long the source lets us keep this (HTTP cache header), for sources
   * whose terms forbid storing (Google Books). Null when the source sent none.
   */
  cacheMaxAgeSeconds?: number | null;
}

export interface NoRatings {
  outcome: 'empty';
  /** `not_found`: no matching book. `no_ratings`: found, nobody rated it. `no_isbn`: needs an ISBN we do not have. */
  reason: 'not_found' | 'no_ratings' | 'no_isbn';
  externalId?: string | null;
}

export type RatingLookup = FoundRatings | NoRatings;

/**
 * One live rating source (D-003). `lookup` resolves to ratings or to `empty`
 * only when the source answered; any failure throws a `SourceError`, so a
 * failure can never be read as "no ratings" (spec 8).
 */
export interface RatingSourceAdapter {
  /** `review_sources.key`. */
  readonly key: string;
  /** False when the source needs a key or token that is not set; it is then not asked. */
  readonly configured: boolean;
  lookup(book: BookRef, signal: AbortSignal): Promise<RatingLookup>;
}

/** Ratings to two decimals (the database column), within the 1 to 5 scale of the contract. */
export function ratingValue(average: number): number {
  return Math.round(Math.min(5, Math.max(1, average)) * 100) / 100;
}
