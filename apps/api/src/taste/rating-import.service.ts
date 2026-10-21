import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { type CatalogHit, CatalogSearch } from '../discovery/catalog-search';
import { type CandidateView, toCandidate } from '../discovery/discovery.schemas';
import { decideScan } from '../discovery/scan-decision';
import { RateLimiter } from '../redis/rate-limiter';
import { parseRatingFile, type RatingRow } from './rating-file';
import { TasteProfileService, type VersionSummary } from './taste-profile.service';

/** Candidates kept for a row the reader has to resolve. */
const ROW_CANDIDATES = 3;

export interface ImportView {
  importId: string;
  status: 'processing' | 'needs_review' | 'confirmed' | 'failed';
  format: 'goodreads' | 'storygraph' | null;
  totalRows: number;
  matchedCount: number;
  ignoredRows: number;
  unmatched: Array<{
    rowIndex: number;
    rawTitle: string;
    rawAuthor: string | null;
    rating: number;
    candidates: CandidateView[];
  }>;
}

export type Resolution = { rowIndex: number; editionId: string } | { rowIndex: number; skip: true };

/**
 * Rating import (spec 6, ONB-1). The file is read in memory and only title,
 * author and rating are kept. Matching uses the same rules as search and
 * scan: exact ids first (Goodreads book id, ISBN), then a fuzzy match that
 * is accepted only when exactly one book fits title and author. Every other
 * row is listed for the reader, never dropped silently.
 */
@Injectable()
export class RatingImportService {
  private readonly logger = new Logger('Import');
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogSearch,
    private readonly taste: TasteProfileService,
    private readonly limiter: RateLimiter,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async upload(
    userId: string,
    file: { buffer: Buffer; size: number } | undefined,
  ): Promise<string> {
    if (!file || file.size === 0) {
      throw new ApiError('VALIDATION_FAILED', {
        fields: { file: 'Attach your exported ratings file.' },
      });
    }
    const limit = await this.limiter.hit(`import:user:${userId}`, {
      max: this.config.IMPORT_MAX_PER_DAY,
      windowSeconds: 86_400,
    });
    if (!limit.allowed) {
      throw new ApiError('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
    }

    const parsed = parseRatingFile(file.buffer, this.config.IMPORT_MAX_ROWS);
    if (!parsed.ok) {
      if (parsed.reason === 'not_text') throw new ApiError('UNSUPPORTED_TYPE');
      const message = {
        unknown_format: 'Upload a Goodreads or StoryGraph export (CSV).',
        no_ratings: 'No rated books were found in this file.',
        too_many_rows: `At most ${this.config.IMPORT_MAX_ROWS} rated books can be imported at once.`,
      }[parsed.reason];
      throw new ApiError('VALIDATION_FAILED', { fields: { file: message } });
    }

    const exact = await this.exactMatches(parsed.rows);
    const created = await this.prisma.ratingImport.create({
      data: {
        userId,
        status: 'processing',
        fileFormat: parsed.format,
        totalRows: parsed.rows.length,
        matchedCount: exact.size,
        ignoredRows: parsed.ignored,
        rows: {
          createMany: {
            data: parsed.rows.map((row) => ({
              rowIndex: row.rowIndex,
              rawTitle: row.title,
              rawAuthor: row.author,
              rating: row.rating,
              status: exact.has(row.rowIndex) ? ('matched' as const) : ('unmatched' as const),
              matchedEditionId: exact.get(row.rowIndex) ?? null,
            })),
          },
        },
      },
      select: { id: true },
    });
    // Fuzzy matching can take a while for big files: it runs after the response.
    void this.process(created.id);
    return created.id;
  }

  /** Matches the remaining rows by title and author, then marks the import ready for review. */
  async process(importId: string): Promise<void> {
    if (this.active.has(importId)) return;
    this.active.add(importId);
    try {
      const rows = await this.prisma.ratingImportRow.findMany({
        where: { importId, status: 'unmatched' },
        orderBy: { rowIndex: 'asc' },
        select: { id: true, rawTitle: true, rawAuthor: true },
      });
      const thresholds = {
        minTitle: this.config.IMPORT_MIN_TITLE_MATCH,
        minAuthor: this.config.IMPORT_MIN_AUTHOR_MATCH,
      };
      for (const row of rows) {
        const hits = await this.catalog.search({
          query: [row.rawTitle, row.rawAuthor].filter(Boolean).join(' '),
          limit: ROW_CANDIDATES * 2,
          cover: { title: row.rawTitle, subtitle: '', author: row.rawAuthor },
        });
        // Same rule as a scan read with full certainty: only one plausible book.
        const { outcome, ordered } = decideScan(
          { authors: row.rawAuthor ? [row.rawAuthor] : [], certainty: 'high' },
          hits,
          thresholds,
        );
        await this.prisma.ratingImportRow.update({
          where: { id: row.id },
          data:
            outcome === 'identified'
              ? {
                  status: 'matched',
                  matchedEditionId: ordered[0]!.editionId,
                  candidateEditionIds: [],
                }
              : { candidateEditionIds: ordered.slice(0, ROW_CANDIDATES).map((h) => h.editionId) },
        });
      }
      const matchedCount = await this.prisma.ratingImportRow.count({
        where: { importId, status: 'matched' },
      });
      await this.prisma.ratingImport.updateMany({
        where: { id: importId, status: 'processing' },
        data: { status: 'needs_review', matchedCount },
      });
    } catch (error) {
      this.logger.error(`Import ${importId} failed: ${(error as Error).message}`);
      await this.prisma.ratingImport
        .updateMany({ where: { id: importId, status: 'processing' }, data: { status: 'failed' } })
        .catch(() => undefined);
    } finally {
      this.active.delete(importId);
    }
  }

  async get(userId: string, importId: string): Promise<ImportView> {
    const found = await this.prisma.ratingImport.findFirst({
      where: { id: importId, userId },
    });
    // Another reader's import is "not found", never "forbidden" (CONTRACT 2).
    if (!found) throw new ApiError('NOT_FOUND');

    if (
      found.status === 'processing' &&
      !this.active.has(found.id) &&
      Date.now() - found.createdAt.getTime() > this.config.IMPORT_STALE_SECONDS * 1000
    ) {
      // Interrupted, for example by a restart: carry on where it stopped.
      void this.process(found.id);
    }

    let unmatched: ImportView['unmatched'] = [];
    if (found.status === 'needs_review') {
      const rows = await this.prisma.ratingImportRow.findMany({
        where: { importId, status: 'unmatched' },
        orderBy: { rowIndex: 'asc' },
      });
      const described = new Map(
        (await this.catalog.describe([...new Set(rows.flatMap((r) => r.candidateEditionIds))])).map(
          (h) => [h.editionId, h],
        ),
      );
      unmatched = rows.map((r) => ({
        rowIndex: r.rowIndex,
        rawTitle: r.rawTitle,
        rawAuthor: r.rawAuthor,
        rating: r.rating,
        candidates: r.candidateEditionIds
          .map((id) => described.get(id))
          .filter((h): h is CatalogHit => h !== undefined)
          .map(toCandidate),
      }));
    }
    return {
      importId: found.id,
      status: found.status,
      format: found.fileFormat as ImportView['format'],
      totalRows: found.totalRows,
      matchedCount: found.matchedCount,
      ignoredRows: found.ignoredRows,
      unmatched,
    };
  }

  /**
   * Saves the import as a new profile version. Rows the reader resolved get
   * the chosen edition; rows left unresolved are skipped (they were listed).
   * Imported ratings replace earlier ratings of the same edition.
   */
  async confirm(
    userId: string,
    importId: string,
    resolutions: Resolution[],
  ): Promise<VersionSummary> {
    return this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRawUnsafe<Array<{ status: string }>>(
          `SELECT status FROM rating_imports WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
          importId,
          userId,
        );
        if (!locked) throw new ApiError('NOT_FOUND');
        // Still matching, already confirmed or failed: the reader can GET the import to see which.
        if (locked.status !== 'needs_review') throw new ApiError('CONFLICT');

        const rows = await tx.ratingImportRow.findMany({
          where: { importId },
          select: { rowIndex: true, rating: true, status: true, matchedEditionId: true },
        });
        const byIndex = new Map(rows.map((r) => [r.rowIndex, r]));
        const fields: Record<string, string> = {};
        const chosenIds = resolutions.flatMap((r) => ('editionId' in r ? [r.editionId] : []));
        const existing = new Set(
          (
            await tx.edition.findMany({ where: { id: { in: chosenIds } }, select: { id: true } })
          ).map((e) => e.id),
        );
        resolutions.forEach((r, i) => {
          if (!byIndex.has(r.rowIndex))
            fields[`resolutions.${i}.rowIndex`] = 'No such row in this import.';
          else if ('editionId' in r && !existing.has(r.editionId)) {
            fields[`resolutions.${i}.editionId`] = 'No such book.';
          }
        });
        if (Object.keys(fields).length > 0) throw new ApiError('VALIDATION_FAILED', { fields });

        const resolved = new Map<number, string | null>();
        for (const r of resolutions)
          resolved.set(r.rowIndex, 'editionId' in r ? r.editionId : null);

        // Final edition per row: the reader's choice, else the automatic match.
        const final = rows.map((row) => {
          const choice = resolved.has(row.rowIndex) ? resolved.get(row.rowIndex)! : undefined;
          if (choice === null) return { ...row, editionId: null, status: 'skipped' as const };
          if (choice) return { ...row, editionId: choice, status: 'resolved' as const };
          if (row.status === 'matched')
            return { ...row, editionId: row.matchedEditionId, status: 'matched' as const };
          return { ...row, editionId: null, status: 'skipped' as const };
        });

        const imported = final.filter((r) => r.editionId).sort((a, b) => a.rowIndex - b.rowIndex); // Later rows win for the same book.
        const version = await this.taste.save(
          userId,
          `Imported ${imported.length} ratings`,
          (state) => {
            for (const r of imported)
              state.ratings.set(r.editionId!, { rating: r.rating, origin: 'imported' });
          },
          { tx },
        );

        for (const status of ['resolved', 'skipped'] as const) {
          const group = final.filter((r) => r.status === status);
          if (group.length === 0) continue;
          await tx.$executeRawUnsafe(
            `UPDATE rating_import_rows r SET status = $2::import_row_status, matched_edition_id = v.edition_id
               FROM unnest($3::int[], $4::uuid[]) AS v(row_index, edition_id)
              WHERE r.import_id = $1::uuid AND r.row_index = v.row_index`,
            importId,
            status,
            group.map((r) => r.rowIndex),
            group.map((r) => r.editionId),
          );
        }
        await tx.ratingImport.update({
          where: { id: importId },
          data: {
            status: 'confirmed',
            confirmedAt: new Date(),
            // Only a version this import created belongs to it.
            resultingVersionId: version.created ? version.id : null,
            matchedCount: imported.length,
          },
        });
        return version;
      },
      { timeout: 30_000 },
    );
  }

  /** Goodreads book ids and ISBNs that are in the catalog, by row index. */
  private async exactMatches(rows: RatingRow[]): Promise<Map<number, string>> {
    const matches = new Map<number, string>();
    const bookIds = [
      ...new Set(rows.flatMap((r) => (r.goodreadsBookId ? [r.goodreadsBookId] : []))),
    ];
    if (bookIds.length > 0) {
      const found = await this.prisma.$queryRawUnsafe<
        Array<{ external_id: string; edition_id: string }>
      >(
        `SELECT x.external_id, x.edition_id FROM edition_external_ids x
           JOIN review_sources s ON s.id = x.source_id AND s.key = 'goodreads_dataset'
          WHERE x.external_id = ANY($1::text[])`,
        bookIds,
      );
      const byBookId = new Map(found.map((f) => [f.external_id, f.edition_id]));
      for (const r of rows) {
        const id = r.goodreadsBookId && byBookId.get(r.goodreadsBookId);
        if (id) matches.set(r.rowIndex, id);
      }
    }
    const remaining = rows.filter((r) => !matches.has(r.rowIndex));
    const isbn13s = [...new Set(remaining.flatMap((r) => (r.isbn13 ? [r.isbn13] : [])))];
    const isbn10s = [...new Set(remaining.flatMap((r) => (r.isbn10 ? [r.isbn10] : [])))];
    if (isbn13s.length > 0 || isbn10s.length > 0) {
      const found = await this.prisma.$queryRawUnsafe<
        Array<{ id: string; isbn_13: string | null; isbn_10: string | null }>
      >(
        `SELECT DISTINCT ON (coalesce(isbn_13, isbn_10)) id, isbn_13, isbn_10 FROM editions
          WHERE isbn_13 = ANY($1::text[]) OR isbn_10 = ANY($2::text[])
          ORDER BY coalesce(isbn_13, isbn_10), id`,
        isbn13s,
        isbn10s,
      );
      const by13 = new Map(found.filter((f) => f.isbn_13).map((f) => [f.isbn_13!, f.id]));
      const by10 = new Map(found.filter((f) => f.isbn_10).map((f) => [f.isbn_10!, f.id]));
      for (const r of remaining) {
        const id = (r.isbn13 && by13.get(r.isbn13)) || (r.isbn10 && by10.get(r.isbn10));
        if (id) matches.set(r.rowIndex, id);
      }
    }
    return matches;
  }
}
