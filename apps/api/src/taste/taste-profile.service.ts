import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';

export type Pace = 'slow' | 'moderate' | 'fast';
export type Sensitivity = 'high' | 'moderate' | 'low';
export type RatingOrigin = 'quick_rate' | 'imported';

/** The full taste input of one profile version. Absent means unknown (ONB-3). */
export interface TasteState {
  ratings: Map<string, { rating: number; origin: RatingOrigin }>;
  likedGenres: Set<string>;
  dislikedGenres: Set<string>;
  pace: Pace | null;
  themesToAvoid: Map<string, Sensitivity>;
}

export interface VersionSummary {
  /** Null only when the reader has never saved anything. */
  id: string | null;
  /** 0 before the first save. */
  versionNo: number;
  ratedCount: number;
  /** False when the save changed nothing, so no version was written. */
  created: boolean;
}

type Tx = Prisma.TransactionClient;

function emptyState(): TasteState {
  return {
    ratings: new Map(),
    likedGenres: new Set(),
    dislikedGenres: new Set(),
    pace: null,
    themesToAvoid: new Map(),
  };
}

function cloneState(s: TasteState): TasteState {
  return {
    ratings: new Map(s.ratings),
    likedGenres: new Set(s.likedGenres),
    dislikedGenres: new Set(s.dislikedGenres),
    pace: s.pace,
    themesToAvoid: new Map(s.themesToAvoid),
  };
}

function sameState(a: TasteState, b: TasteState): boolean {
  const sameMap = <V>(x: Map<string, V>, y: Map<string, V>, eq: (p: V, q: V) => boolean) =>
    x.size === y.size && [...x].every(([k, v]) => y.has(k) && eq(v, y.get(k)!));
  const sameSet = (x: Set<string>, y: Set<string>) =>
    x.size === y.size && [...x].every((k) => y.has(k));
  return (
    a.pace === b.pace &&
    sameSet(a.likedGenres, b.likedGenres) &&
    sameSet(a.dislikedGenres, b.dislikedGenres) &&
    sameMap(a.themesToAvoid, b.themesToAvoid, (p, q) => p === q) &&
    sameMap(a.ratings, b.ratings, (p, q) => p.rating === q.rating && p.origin === q.origin)
  );
}

/**
 * Taste profile versions (spec 4, ONB-4). Every save writes a complete new
 * version: rows of a version can never change (database triggers), and child
 * rows can only be added in the transaction that creates the version. A
 * per-reader lock keeps version numbers in order when saves overlap.
 */
@Injectable()
export class TasteProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** The reader's current version, or null before their first save. */
  async current(
    userId: string,
  ): Promise<{ id: string; versionNo: number; createdAt: Date; state: TasteState } | null> {
    return this.prisma.$transaction((tx) => this.loadLatest(tx, userId));
  }

  /**
   * Applies `change` to a copy of the current state and saves it as a new
   * version. Nothing is saved if the change leaves the state as it was.
   * Saving any taste input also completes onboarding (D-002).
   */
  async save(
    userId: string,
    changeSummary: string,
    change: (state: TasteState, tx: Tx) => void | Promise<void>,
    options: { tx?: Tx } = {},
  ): Promise<VersionSummary> {
    const run = async (tx: Tx): Promise<VersionSummary> => {
      await tx.$queryRawUnsafe(
        `SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('taste:' || $1))`,
        userId,
      );
      const latest = await this.loadLatest(tx, userId);
      const before = latest?.state ?? emptyState();
      const next = cloneState(before);
      await change(next, tx);
      if (sameState(before, next)) {
        return {
          id: latest?.id ?? null,
          versionNo: latest?.versionNo ?? 0,
          ratedCount: before.ratings.size,
          created: false,
        };
      }
      const version = await tx.tasteProfileVersion.create({
        data: {
          userId,
          versionNo: (latest?.versionNo ?? 0) + 1,
          pace: next.pace,
          changeSummary,
        },
        select: { id: true, versionNo: true },
      });
      if (next.ratings.size > 0) {
        await tx.profileRating.createMany({
          data: [...next.ratings].map(([editionId, r]) => ({
            tasteProfileVersionId: version.id,
            editionId,
            rating: r.rating,
            origin: r.origin,
          })),
        });
      }
      const genreIds = await this.ids(tx, 'genres', [...next.likedGenres, ...next.dislikedGenres]);
      const genreRows = [
        ...[...next.likedGenres].map((name) => ({ name, preference: 'liked' as const })),
        ...[...next.dislikedGenres].map((name) => ({ name, preference: 'disliked' as const })),
      ];
      if (genreRows.length > 0) {
        await tx.profileGenrePreference.createMany({
          data: genreRows.map((g) => ({
            tasteProfileVersionId: version.id,
            genreId: genreIds.get(g.name)!,
            preference: g.preference,
          })),
        });
      }
      if (next.themesToAvoid.size > 0) {
        const themeIds = await this.ids(tx, 'themes', [...next.themesToAvoid.keys()]);
        await tx.profileThemeAvoidance.createMany({
          data: [...next.themesToAvoid].map(([name, sensitivity]) => ({
            tasteProfileVersionId: version.id,
            themeId: themeIds.get(name)!,
            sensitivity,
          })),
        });
      }
      await tx.user.updateMany({
        where: { id: userId, onboardingState: { not: 'completed' } },
        data: { onboardingState: 'completed' },
      });
      return {
        id: version.id,
        versionNo: version.versionNo,
        ratedCount: next.ratings.size,
        created: true,
      };
    };
    return options.tx ? run(options.tx) : this.prisma.$transaction(run, { timeout: 30_000 });
  }

  /**
   * ONB-4: results made with an earlier version are outdated. Computed when
   * read, never stored, so it cannot go stale. Used by the analysis API (BE-8).
   */
  async isOutdated(userId: string, tasteProfileVersionId: string | null): Promise<boolean> {
    const latest = await this.prisma.tasteProfileVersion.findFirst({
      where: { userId },
      orderBy: { versionNo: 'desc' },
      select: { id: true },
    });
    return (latest?.id ?? null) !== tasteProfileVersionId;
  }

  /** Checks that an edition exists (NOT_FOUND otherwise). */
  async requireEdition(editionId: string, tx: Tx | PrismaService = this.prisma): Promise<void> {
    const found = await tx.edition.findUnique({ where: { id: editionId }, select: { id: true } });
    if (!found) throw new ApiError('NOT_FOUND');
  }

  private async loadLatest(
    tx: Tx,
    userId: string,
  ): Promise<{ id: string; versionNo: number; createdAt: Date; state: TasteState } | null> {
    const version = await tx.tasteProfileVersion.findFirst({
      where: { userId },
      orderBy: { versionNo: 'desc' },
      include: {
        ratings: { select: { editionId: true, rating: true, origin: true } },
        genrePreferences: { select: { preference: true, genre: { select: { name: true } } } },
        themeAvoidances: { select: { sensitivity: true, theme: { select: { name: true } } } },
      },
    });
    if (!version) return null;
    const state = emptyState();
    for (const r of version.ratings)
      state.ratings.set(r.editionId, { rating: r.rating, origin: r.origin });
    for (const g of version.genrePreferences) {
      (g.preference === 'liked' ? state.likedGenres : state.dislikedGenres).add(g.genre.name);
    }
    for (const t of version.themeAvoidances) state.themesToAvoid.set(t.theme.name, t.sensitivity);
    state.pace = version.pace;
    return { id: version.id, versionNo: version.versionNo, createdAt: version.createdAt, state };
  }

  private async ids(
    tx: Tx,
    table: 'genres' | 'themes',
    names: string[],
  ): Promise<Map<string, number>> {
    if (names.length === 0) return new Map();
    const rows =
      table === 'genres'
        ? await tx.genre.findMany({
            where: { name: { in: names } },
            select: { id: true, name: true },
          })
        : await tx.theme.findMany({
            where: { name: { in: names } },
            select: { id: true, name: true },
          });
    return new Map(rows.map((r) => [r.name, r.id]));
  }
}
