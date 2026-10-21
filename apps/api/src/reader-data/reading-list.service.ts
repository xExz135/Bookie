import { Injectable } from '@nestjs/common';
import { AnalysisView } from '../analysis/analysis-view';
import { ApiError } from '../common/api-error';
import type { ReadingListGroup } from '../contract/enums';
import { PrismaService } from '../database/prisma.service';
import { CatalogSearch } from '../discovery/catalog-search';
import { toCandidate } from '../discovery/discovery.schemas';
import type { ReadingList, ReadingListEntry, ReadingListItem } from './reader-data.schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Match = NonNullable<ReadingListItem['personalMatch']>;

/** LIST-2: only a score of medium or high confidence is ranked; a low or fallback one is labeled. */
export function groupOf(match: Match | null): ReadingListGroup {
  if (!match || match.status !== 'done' || match.score === null) return 'no_match';
  const low =
    match.isFallback || !match.evidenceConfidence || match.evidenceConfidence.level === 'low';
  return low ? 'low_confidence' : 'ranked';
}

/**
 * LIST-1, LIST-2: ranked items first by stored score (highest first), then
 * low-confidence and unmatched items, each newest added first. Ties fall
 * back to the time added and the edition id, so the order is stable.
 */
export function orderReadingList(items: ReadingListItem[]): ReadingListItem[] {
  const rank = (g: ReadingListGroup) => ['ranked', 'low_confidence', 'no_match'].indexOf(g);
  return [...items].sort(
    (x, y) =>
      rank(x.group) - rank(y.group) ||
      (x.group === 'ranked' ? y.personalMatch!.score! - x.personalMatch!.score! : 0) ||
      y.addedAt.localeCompare(x.addedAt) ||
      x.edition.editionId.localeCompare(y.edition.editionId),
  );
}

/**
 * The reader's reading list (spec 6, CONTRACT 4.5). Each item shows the
 * personal match of the reader's latest finished analysis of that edition,
 * as stored: the order changes only when a new analysis finishes (LIST-1).
 */
@Injectable()
export class ReadingListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly view: AnalysisView,
    private readonly catalog: CatalogSearch,
  ) {}

  async list(userId: string): Promise<ReadingList> {
    const rows = await this.prisma.readingListItem.findMany({
      where: { userId },
      select: { editionId: true, addedAt: true },
    });
    if (rows.length === 0) return { items: [] };
    const editionIds = rows.map((r) => r.editionId);

    const [described, latest] = await Promise.all([
      this.catalog.describe(editionIds),
      // A running analysis is left out, so the list does not move until it finishes.
      this.prisma.$queryRaw<Array<{ edition_id: string; id: string }>>`
        SELECT DISTINCT ON (edition_id) edition_id::text, id::text
        FROM analyses
        WHERE user_id = ${userId}::uuid
          AND edition_id = ANY(${editionIds}::uuid[])
          AND status <> 'running'
        ORDER BY edition_id, created_at DESC, id DESC`,
    ]);
    const editions = new Map(described.map((hit) => [hit.editionId, toCandidate(hit)]));
    const analysisOf = new Map(latest.map((r) => [r.edition_id, r.id]));

    const items: ReadingListItem[] = [];
    for (const row of rows) {
      const edition = editions.get(row.editionId);
      if (!edition) continue;
      const analysisId = analysisOf.get(row.editionId) ?? null;
      const full = analysisId ? await this.view.get(userId, analysisId) : null;
      const personalMatch = full ? this.view.toSummary(full).personalMatch : null;
      items.push({
        edition,
        addedAt: row.addedAt.toISOString(),
        analysisId: full ? analysisId : null,
        group: groupOf(personalMatch),
        personalMatch,
      });
    }
    return { items: orderReadingList(items) };
  }

  /** Adds a book; adding one already on the list changes nothing (`created` false). */
  async add(
    userId: string,
    editionId: string,
  ): Promise<{ entry: ReadingListEntry; created: boolean }> {
    const edition = await this.prisma.edition.findUnique({
      where: { id: editionId },
      select: { id: true },
    });
    if (!edition) throw new ApiError('NOT_FOUND', { message: 'Unknown edition.' });
    const existing = await this.prisma.readingListItem.findUnique({
      where: { userId_editionId: { userId, editionId } },
      select: { addedAt: true },
    });
    if (existing)
      return { entry: { editionId, addedAt: existing.addedAt.toISOString() }, created: false };
    try {
      const row = await this.prisma.readingListItem.create({
        data: { userId, editionId },
        select: { addedAt: true },
      });
      return { entry: { editionId, addedAt: row.addedAt.toISOString() }, created: true };
    } catch (error) {
      // Added at the same moment from another tab.
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const row = await this.prisma.readingListItem.findUniqueOrThrow({
        where: { userId_editionId: { userId, editionId } },
        select: { addedAt: true },
      });
      return { entry: { editionId, addedAt: row.addedAt.toISOString() }, created: false };
    }
  }

  /** Removing a book that is not on the list changes nothing. */
  async remove(userId: string, editionId: string): Promise<void> {
    if (!UUID.test(editionId)) throw new ApiError('NOT_FOUND');
    await this.prisma.readingListItem.deleteMany({ where: { userId, editionId } });
  }
}
