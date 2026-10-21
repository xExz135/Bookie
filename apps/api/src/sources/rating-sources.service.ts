import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { OPEN_LIBRARY_KEY } from './open-library/open-library-ratings';
import type { BookRef, MatchedBy, RatingScope, RatingSourceAdapter } from './rating-source';
import { SourceError } from './source-error';
import { RATING_SOURCES } from './sources.tokens';

export type SourceRatingOutcome = 'ok' | 'empty' | 'failed' | 'rate_limited';

/**
 * One source's answer for one edition, in the shape BE-8 stores in
 * `review_fetches` and shows in `Analysis.sources` (CONTRACT 4.4).
 */
export interface SourceRating {
  key: string;
  /** Display name from `review_sources`. Hardcover's terms require it next to its numbers. */
  name: string;
  providesText: boolean;
  storageAllowed: boolean;
  displayAllowed: boolean;
  outcome: SourceRatingOutcome;
  ratingAverage: number | null;
  ratingCount: number | null;
  ratingScope: RatingScope | null;
  externalId: string | null;
  matchedBy: MatchedBy | null;
  /** Why it was empty (`not_found`, `no_ratings`, `no_isbn`) or why it failed (`timeout`, `unauthorized`, ...). */
  detail: string | null;
  fetchedAt: Date;
  /** When to ask again. Failures expire soon and are retried (spec 10); they never stand for "no ratings". */
  expiresAt: Date;
  durationMs: number;
}

interface SourcePolicy {
  key: string;
  name: string;
  provides_text: boolean;
  storage_allowed: boolean;
  display_allowed: boolean;
}

const HOUR = 3_600_000;

/**
 * Asks every permitted live source for an edition's ratings, in parallel,
 * each within a deadline (spec 8). Rules:
 * - A source is asked only when its `review_sources` row exists and is
 *   enabled (terms checked, D-003) and its key or token is set.
 * - One source failing never affects the others (spec 11 "some sources fail").
 * - A failure is `failed` or `rate_limited` with a short expiry, never `empty`
 *   (RES-4, spec 10).
 * - A source that may not be stored (Google Books) expires when its HTTP
 *   cache header says, or at once when it sends none.
 * Nothing is written here; BE-8 records the results with the analysis.
 */
@Injectable()
export class RatingSourcesService {
  private readonly logger = new Logger(RatingSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
    @Inject(RATING_SOURCES) private readonly adapters: RatingSourceAdapter[],
  ) {}

  /** Null when the edition is not in the catalog. */
  async lookupEdition(editionId: string): Promise<SourceRating[] | null> {
    const book = await this.loadBook(editionId);
    return book ? this.lookup(book) : null;
  }

  async lookup(book: BookRef): Promise<SourceRating[]> {
    const policies = await this.policies();
    const asked = this.adapters.filter((a) => a.configured && policies.has(a.key));
    return Promise.all(asked.map((a) => this.ask(a, policies.get(a.key)!, book)));
  }

  /** What the adapters need: title, main authors, ISBNs and any known Open Library work key. */
  async loadBook(editionId: string): Promise<BookRef | null> {
    const [row] = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        title: string;
        subtitle: string | null;
        isbn_13: string | null;
        isbn_10: string | null;
        authors: string[] | null;
        ol_work: string | null;
      }>
    >(
      `SELECT e.id, e.title, e.subtitle, e.isbn_13, e.isbn_10,
         -- Main authors only (no role); translators and illustrators would mislead the match.
         COALESCE(
           (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
              JOIN authors a ON a.id = ea.author_id
             WHERE ea.edition_id = e.id AND ea.role IS NULL),
           (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
              JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id)
         ) AS authors,
         (SELECT w.external_id FROM work_external_ids w
            JOIN review_sources s ON s.id = w.source_id
           WHERE w.work_id = e.work_id AND s.key = $2) AS ol_work
       FROM editions e WHERE e.id = $1::uuid`,
      editionId,
      OPEN_LIBRARY_KEY,
    );
    if (!row) return null;
    return {
      editionId: row.id,
      title: row.title,
      subtitle: row.subtitle,
      authors: row.authors ?? [],
      isbn13: row.isbn_13,
      isbn10: row.isbn_10,
      openLibraryWorkKey: row.ol_work && /^OL\d+W$/.test(row.ol_work) ? row.ol_work : null,
    };
  }

  private async policies(): Promise<Map<string, SourcePolicy>> {
    const rows = await this.prisma.$queryRawUnsafe<SourcePolicy[]>(
      `SELECT key, name, provides_text, storage_allowed, display_allowed
         FROM review_sources WHERE enabled AND key = ANY($1::text[])`,
      this.adapters.map((a) => a.key),
    );
    return new Map(rows.map((r) => [r.key, r]));
  }

  private async ask(
    adapter: RatingSourceAdapter,
    policy: SourcePolicy,
    book: BookRef,
  ): Promise<SourceRating> {
    const started = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.config.SOURCE_DEADLINE_MS);
    const base = {
      key: policy.key,
      name: policy.name,
      providesText: policy.provides_text,
      storageAllowed: policy.storage_allowed,
      displayAllowed: policy.display_allowed,
    };
    let result: SourceRating;
    try {
      const found = await Promise.race([
        adapter.lookup(book, controller.signal),
        // An adapter that ignores the signal still cannot hold up the others.
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new SourceError('failed', 'Deadline passed', 'timeout')),
          ),
        ),
      ]);
      const fetchedAt = new Date();
      if (found.outcome === 'ok') {
        result = {
          ...base,
          outcome: 'ok',
          ratingAverage: found.ratingAverage,
          ratingCount: found.ratingCount,
          ratingScope: found.ratingScope,
          externalId: found.externalId,
          matchedBy: found.matchedBy,
          detail: null,
          fetchedAt,
          expiresAt: this.okExpiry(policy, fetchedAt, found.cacheMaxAgeSeconds ?? null),
          durationMs: Date.now() - started,
        };
      } else {
        result = {
          ...base,
          outcome: 'empty',
          ratingAverage: null,
          ratingCount: null,
          ratingScope: null,
          externalId: found.externalId ?? null,
          matchedBy: null,
          detail: found.reason,
          fetchedAt,
          expiresAt: new Date(
            fetchedAt.getTime() + this.config.CACHE_SOURCE_EMPTY_TTL_HOURS * HOUR,
          ),
          durationMs: Date.now() - started,
        };
      }
    } catch (error) {
      const fetchedAt = new Date();
      const known = error instanceof SourceError;
      if (!known) this.logger.error(`${policy.key}: unexpected error: ${(error as Error).message}`);
      result = {
        ...base,
        outcome: known ? error.outcome : 'failed',
        ratingAverage: null,
        ratingCount: null,
        ratingScope: null,
        externalId: null,
        matchedBy: null,
        detail: known ? error.code : 'internal',
        fetchedAt,
        expiresAt: new Date(
          fetchedAt.getTime() + this.config.CACHE_SOURCE_FAILURE_TTL_MINUTES * 60_000,
        ),
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(deadline);
    }
    // Structured, secret-free log line per source (spec 12 observability).
    this.logger.log(
      JSON.stringify({
        event: 'source_ratings',
        source: result.key,
        editionId: book.editionId,
        outcome: result.outcome,
        detail: result.detail,
        matchedBy: result.matchedBy,
        durationMs: result.durationMs,
      }),
    );
    return result;
  }

  private okExpiry(policy: SourcePolicy, fetchedAt: Date, cacheMaxAgeSeconds: number | null): Date {
    if (policy.storage_allowed)
      return new Date(fetchedAt.getTime() + this.config.CACHE_REVIEWS_TTL_DAYS * 24 * HOUR);
    // Live only (Google Books): no longer than the cache header allows; no header, no keeping.
    return new Date(fetchedAt.getTime() + Math.max(0, cacheMaxAgeSeconds ?? 0) * 1000);
  }
}
