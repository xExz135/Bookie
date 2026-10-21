import { Inject, Injectable, Logger } from '@nestjs/common';
import { hashForKey } from '../auth/tokens';
import { normalizeForSearch } from '../catalog/normalize';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { RateLimiter } from '../redis/rate-limiter';
import { RedisService } from '../redis/redis.service';
import { type OpenLibraryClient, SourceError } from '../sources/open-library/open-library.client';
import { type CatalogHit, CatalogSearch, type SearchInput } from './catalog-search';
import { type BookSearchResult, type ExternalLookup, toCandidate } from './discovery.schemas';
import { OpenLibraryImport } from './open-library-import';

export const OPEN_LIBRARY = Symbol('OPEN_LIBRARY');

/** Open Library results asked for per lookup. Only the best edition of each work is used. */
const EXTERNAL_RESULTS = 5;

type Outcome = NonNullable<ExternalLookup>['outcome'];

/**
 * Typed search (spec 6, DISC-1): the stored catalog first, then Open Library
 * when nothing matches well. Open Library results are added to the catalog,
 * then the catalog search runs again, so every candidate has an edition id
 * and is ranked the same way.
 */
@Injectable()
export class BookSearchService {
  private readonly logger = new Logger('Search');

  constructor(
    private readonly catalog: CatalogSearch,
    private readonly importer: OpenLibraryImport,
    private readonly limiter: RateLimiter,
    private readonly redis: RedisService,
    @Inject(OPEN_LIBRARY) private readonly openLibrary: OpenLibraryClient,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async search(userId: string, query: string): Promise<BookSearchResult> {
    const limit = await this.limiter.hit(`search:user:${userId}`, {
      max: this.config.SEARCH_RATE_LIMIT_PER_MINUTE,
      windowSeconds: 60,
    });
    if (!limit.allowed) {
      throw new ApiError('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
    }
    const input = { query, limit: this.config.SEARCH_MAX_CANDIDATES };
    const { hits, external } = await this.searchWithFallback(input, (found) =>
      found.some((h) => h.score >= this.config.SEARCH_EXTERNAL_BELOW_SCORE),
    );
    return { candidates: hits.map(toCandidate), external };
  }

  /**
   * Catalog search, then Open Library if `goodEnough` says the catalog
   * results are not enough. Shared with the scan.
   */
  async searchWithFallback(
    input: SearchInput,
    goodEnough: (hits: CatalogHit[]) => boolean,
  ): Promise<{ hits: CatalogHit[]; external: ExternalLookup }> {
    const hits = await this.catalog.search(input);
    if (goodEnough(hits) || !this.config.OPEN_LIBRARY_ENABLED) return { hits, external: null };
    const outcome = await this.lookUpExternally(input.query);
    const external = { source: 'open_library' as const, outcome };
    if (outcome !== 'ok') return { hits, external };
    return { hits: await this.catalog.search(input), external };
  }

  /**
   * Asks Open Library and adds what it finds to the catalog. Outcomes are
   * remembered (spec 10: empty results about a day, failures minutes), so a
   * repeated search does not call Open Library again.
   */
  private async lookUpExternally(query: string): Promise<Outcome> {
    const language = this.config.EVIDENCE_LANGUAGES.split(',')[0]?.trim() || undefined;
    const key = `ol:search:${hashForKey(`${language ?? ''}|${normalizeForSearch(query)}`)}`;
    const cached = await this.cacheGet(key);
    if (cached) return cached;

    let outcome: Outcome;
    try {
      const works = await this.openLibrary.searchWorks(query, {
        limit: EXTERNAL_RESULTS,
        language,
      });
      const usable = works.filter((w) => w.edition);
      if (usable.length === 0) {
        outcome = 'empty';
      } else {
        await this.importer.importWorks(usable);
        outcome = 'ok';
      }
    } catch (error) {
      // A failed source is reported as failed, never as "no results" (spec 8).
      outcome = error instanceof SourceError ? error.outcome : 'failed';
      this.logger.warn(`Open Library search failed: ${(error as Error).message}`);
    }
    const ttlSeconds =
      outcome === 'failed' || outcome === 'rate_limited'
        ? this.config.CACHE_SOURCE_FAILURE_TTL_MINUTES * 60
        : this.config.CACHE_SOURCE_EMPTY_TTL_HOURS * 3600;
    await this.cacheSet(key, outcome, ttlSeconds);
    return outcome;
  }

  private async cacheGet(key: string): Promise<Outcome | null> {
    try {
      const client = await this.redis.connection();
      return (await client.get(`${this.redis.prefix}${key}`)) as Outcome | null;
    } catch {
      return null; // Without Redis, search still works; it just asks again.
    }
  }

  private async cacheSet(key: string, value: Outcome, ttlSeconds: number): Promise<void> {
    try {
      const client = await this.redis.connection();
      await client.set(`${this.redis.prefix}${key}`, value, 'EX', ttlSeconds);
    } catch {
      // Same as above.
    }
  }
}
