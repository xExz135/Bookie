import { type MatchThresholds, bestMatch, bookIsbns } from '../book-match';
import {
  type BookRef,
  type MatchedBy,
  type RatingLookup,
  type RatingSourceAdapter,
  ratingValue,
} from '../rating-source';
import type { OpenLibraryClient, OpenLibraryWork } from './open-library.client';

export const OPEN_LIBRARY_KEY = 'open_library';

/**
 * Open Library ratings (D-003, D-020). Ratings belong to the work, so they
 * cover every edition (`ratingScope: work`). The work is found by, in order:
 * the key the catalog already has (books added by BE-6), an ISBN search, then
 * a title and author search. ISBN results are checked like any other, because
 * Open Library's ISBN lookups can return another book (test log 2026-10-21).
 */
export class OpenLibraryRatings implements RatingSourceAdapter {
  readonly key = OPEN_LIBRARY_KEY;
  readonly configured = true;

  constructor(
    private readonly client: OpenLibraryClient,
    private readonly options: MatchThresholds & { searchResults: number },
  ) {}

  async lookup(book: BookRef, signal: AbortSignal): Promise<RatingLookup> {
    const found = await this.findWork(book, signal);
    if (!found) return { outcome: 'empty', reason: 'not_found' };
    const ratings = await this.client.workRatings(found.workKey, signal);
    if (ratings.count === 0 || ratings.average === null)
      return { outcome: 'empty', reason: 'no_ratings', externalId: found.workKey };
    return {
      outcome: 'ok',
      ratingAverage: ratingValue(ratings.average),
      ratingCount: ratings.count,
      ratingScope: 'work',
      externalId: found.workKey,
      matchedBy: found.matchedBy,
    };
  }

  private async findWork(
    book: BookRef,
    signal: AbortSignal,
  ): Promise<{ workKey: string; matchedBy: MatchedBy } | null> {
    if (book.openLibraryWorkKey) return { workKey: book.openLibraryWorkKey, matchedBy: 'known_id' };

    const isbn = bookIsbns(book)[0];
    if (isbn) {
      const works = await this.client.searchWorks(`isbn:${isbn}`, { limit: 3, signal });
      const hit = this.pick(book, works);
      if (hit) return { workKey: hit.key, matchedBy: 'isbn' };
    }

    const query = [book.title, book.authors[0]].filter(Boolean).join(' ');
    const works = await this.client.searchWorks(query, {
      limit: this.options.searchResults,
      signal,
    });
    const hit = this.pick(book, works);
    return hit ? { workKey: hit.key, matchedBy: 'title_author' } : null;
  }

  private pick(book: BookRef, works: OpenLibraryWork[]): OpenLibraryWork | null {
    const top = bestMatch(
      book,
      works,
      (w) => ({
        titles: [w.title, w.edition?.title].filter((t): t is string => !!t),
        authors: w.authors.map((a) => a.name),
        isbns: [w.edition?.isbn13, w.edition?.isbn10].filter((i): i is string => !!i),
      }),
      this.options,
    );
    return top?.candidate ?? null;
  }
}
