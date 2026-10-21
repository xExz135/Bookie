import { Injectable } from '@nestjs/common';
import { normalizeForSearch } from '../catalog/normalize';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';

/** One catalog edition that matches a query, with the scores used to rank it. */
export interface CatalogHit {
  editionId: string;
  workId: string;
  title: string;
  subtitle: string | null;
  /** Main authors (no role); everyone listed when no one is marked as main author. */
  authors: string[];
  year: number | null;
  language: string | null;
  publisher: string | null;
  format: string | null;
  coverUrl: string | null;
  /** How well the edition matches the query, 0 to 1 (trigram similarity). */
  score: number;
  /** Scan only: title match against what the cover says, 0 to 1. */
  titleScore: number | null;
  /** Scan only: author match against the first author on the cover, 0 to 1. */
  authorScore: number | null;
}

export interface SearchInput {
  query: string;
  limit: number;
  /** Scan only: the title, subtitle and first author read from the cover. */
  cover?: { title: string; subtitle: string; author: string | null };
}

/** Removes everything but digits and X, then checks for an ISBN-10 or ISBN-13. */
export function parseIsbn(query: string): { isbn10: string | null; isbn13: string } | null {
  const compact = query.replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(compact)) {
    const digits = [...compact].map(Number);
    const sum = digits.slice(0, 12).reduce((s, d, i) => s + d * (i % 2 === 0 ? 1 : 3), 0);
    if ((10 - (sum % 10)) % 10 !== digits[12]) return null;
    return { isbn10: null, isbn13: compact };
  }
  if (/^\d{9}[\dX]$/.test(compact)) {
    const sum = [...compact].reduce((s, c, i) => s + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    if (sum % 11 !== 0) return null;
    const core = `978${compact.slice(0, 9)}`;
    const total = [...core].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return { isbn10: compact, isbn13: `${core}${(10 - (total % 10)) % 10}` };
  }
  return null;
}

const DISPLAY_COLUMNS = `
  e.id AS "editionId", e.work_id AS "workId", e.title, e.subtitle,
  coalesce(
    (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
       JOIN authors a ON a.id = ea.author_id
      WHERE ea.edition_id = e.id AND coalesce(ea.role, '') = ''),
    (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
       JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id),
    ARRAY[]::text[]
  ) AS authors,
  e.publication_year AS year, e.language, e.publisher, e.format, e.cover_url AS "coverUrl"`;

/**
 * Fuzzy search over the stored catalog (spec 6: "queries are normalized and
 * fuzzy-matched against stored books first"). Uses the trigram indexes from
 * the first migration. Returns at most one edition per work, so three
 * candidates are three different books; within a work the most-rated edition
 * of the dataset is chosen, since it carries the most reviews.
 */
@Injectable()
export class CatalogSearch {
  private popularCache: { at: number; limit: number; hits: CatalogHit[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  /** Display fields for these editions, in the order given. Unknown ids are left out. */
  async describe(editionIds: string[]): Promise<CatalogHit[]> {
    if (editionIds.length === 0) return [];
    const rows = await this.prisma.$queryRawUnsafe<RawHit[]>(
      `SELECT ${DISPLAY_COLUMNS}, 1::float8 AS score, NULL::float8 AS "titleScore",
         NULL::float8 AS "authorScore"
       FROM editions e WHERE e.id = ANY($1::uuid[])`,
      editionIds,
    );
    const byId = new Map(rows.map((r) => [r.editionId, toHit(r)]));
    return editionIds.map((id) => byId.get(id)).filter((h): h is CatalogHit => h !== undefined);
  }

  /**
   * The most-rated books in the dataset, one edition per work: the starting
   * list for quick rate before anything is typed. Kept for 10 minutes.
   */
  async popular(limit: number): Promise<CatalogHit[]> {
    const cached = this.popularCache;
    if (cached && cached.limit >= limit && Date.now() - cached.at < 600_000) {
      return cached.hits.slice(0, limit);
    }
    const rows = await this.prisma.$queryRawUnsafe<RawHit[]>(
      `WITH top AS (
         SELECT f.edition_id, f.rating_count FROM review_fetches f
          WHERE f.reviews_version = 1
            AND f.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
            AND f.rating_count IS NOT NULL
          ORDER BY f.rating_count DESC LIMIT $1
       ), best AS (
         SELECT DISTINCT ON (e.work_id) e.id, t.rating_count
           FROM top t JOIN editions e ON e.id = t.edition_id
          ORDER BY e.work_id, t.rating_count DESC, e.id
       )
       SELECT ${DISPLAY_COLUMNS}, 1::float8 AS score, NULL::float8 AS "titleScore",
         NULL::float8 AS "authorScore"
       FROM best b JOIN editions e ON e.id = b.id
       ORDER BY b.rating_count DESC, e.id LIMIT $2`,
      limit * 5,
      limit,
    );
    const hits = rows.map(toHit);
    this.popularCache = { at: Date.now(), limit, hits };
    return hits;
  }

  async search(input: SearchInput): Promise<CatalogHit[]> {
    const isbn = parseIsbn(input.query);
    if (isbn) {
      const hits = await this.byIsbn(isbn, input.limit);
      if (hits.length > 0) return hits;
    }
    const query = normalizeForSearch(input.query);
    if (query.length < 2) return [];
    const coverTitle = input.cover ? normalizeForSearch(input.cover.title) : '';
    const coverAuthor = input.cover?.author ? normalizeForSearch(input.cover.author) : '';
    const minScore = this.config.SEARCH_MIN_SCORE;

    return this.prisma.$transaction(async (tx) => {
      // Thresholds for the indexed trigram operators (%, <%), and a time limit
      // so one broad query cannot hold a connection for long.
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.similarity_threshold = ${minScore}`);
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${minScore}`);
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${Math.round(this.config.SEARCH_TIMEOUT_MS)}`,
      );
      const rows = await tx.$queryRawUnsafe<RawHit[]>(
        `WITH matches AS (
           SELECT e.id, e.work_id,
             greatest(
               similarity(e.normalized_title, $1),
               word_similarity($1, e.normalized_title) * 0.95,
               word_similarity($1, e.normalized_authors) * 0.9,
               similarity(e.normalized_title || ' ' || e.normalized_authors, $1)
             ) AS score,
             CASE WHEN $2 = '' THEN NULL ELSE
               greatest(similarity(e.normalized_title, $2),
                        similarity(e.normalized_title, $2 || ' ' || $3)) END AS title_score,
             CASE WHEN $4 = '' THEN NULL ELSE word_similarity($4, e.normalized_authors) END
               AS author_score,
             coalesce(f.rating_count, 0) AS ratings
           FROM editions e
           LEFT JOIN review_fetches f
             ON f.edition_id = e.id AND f.reviews_version = 1
            AND f.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
           WHERE e.normalized_title % $1 OR $1 <% e.normalized_title OR $1 <% e.normalized_authors
         ),
         best_per_work AS (
           SELECT *,
             score + $5 * least(ln(ratings + 1) / ln(10) / 7, 1) AS rank,
             row_number() OVER (PARTITION BY work_id ORDER BY score DESC, ratings DESC, id) AS n
           FROM matches WHERE score >= $6
         )
         SELECT ${DISPLAY_COLUMNS},
           b.score::float8 AS score, b.title_score::float8 AS "titleScore",
           b.author_score::float8 AS "authorScore"
         FROM best_per_work b JOIN editions e ON e.id = b.id
         WHERE b.n = 1
         ORDER BY b.rank DESC, b.ratings DESC, e.id
         LIMIT $7`,
        query,
        coverTitle,
        input.cover ? normalizeForSearch(input.cover.subtitle) : '',
        coverAuthor,
        this.config.SEARCH_POPULARITY_WEIGHT,
        minScore,
        input.limit,
      );
      return rows.map(toHit);
    });
  }

  private async byIsbn(
    isbn: { isbn10: string | null; isbn13: string },
    limit: number,
  ): Promise<CatalogHit[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawHit[]>(
      `SELECT DISTINCT ON (e.work_id) ${DISPLAY_COLUMNS},
         1::float8 AS score, NULL::float8 AS "titleScore", NULL::float8 AS "authorScore"
       FROM editions e
       WHERE e.isbn_13 = $1 OR ($2::text IS NOT NULL AND e.isbn_10 = $2)
       ORDER BY e.work_id, e.id
       LIMIT $3`,
      isbn.isbn13,
      isbn.isbn10,
      limit,
    );
    return rows.map(toHit);
  }
}

interface RawHit extends Omit<CatalogHit, 'authors'> {
  authors: string[] | null;
}

function toHit(row: RawHit): CatalogHit {
  return { ...row, authors: row.authors ?? [] };
}
