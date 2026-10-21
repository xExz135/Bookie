import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { BookSearchService } from '../discovery/book-search.service';
import { CatalogSearch } from '../discovery/catalog-search';
import { toCandidate } from '../discovery/discovery.schemas';
import { RateLimiter } from '../redis/rate-limiter';
import { TasteProfileService, type VersionSummary } from './taste-profile.service';
import {
  type CatalogSearchResult,
  PACES,
  type ProfileSaved,
  type QuestionnaireOptions,
  type QuestionnaireRequest,
  type RatingList,
  type TasteProfileView,
} from './taste.schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Taste capture (spec 6, CONTRACT 4.2): profile, quick rate, questionnaire, onboarding. */
@Injectable()
export class TasteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: TasteProfileService,
    private readonly catalog: CatalogSearch,
    private readonly search: BookSearchService,
    private readonly limiter: RateLimiter,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async profile(userId: string): Promise<TasteProfileView> {
    const current = await this.profiles.current(userId);
    const state = current?.state;
    // Nothing saved is the same as unknown: null, never an empty dislike list.
    const listOrNull = (values: Iterable<string> | undefined) => {
      const list = values ? [...values].sort() : [];
      return list.length > 0 ? list : null;
    };
    const themes = state ? [...state.themesToAvoid].sort(([a], [b]) => a.localeCompare(b)) : [];
    return {
      version: current?.versionNo ?? 0,
      ratedCount: state?.ratings.size ?? 0,
      minForConfidence: this.config.TASTE_MIN_RATED_FOR_CONFIDENCE,
      hardFloor: this.config.TASTE_HARD_FLOOR,
      questionnaire: {
        likedGenres: listOrNull(state?.likedGenres),
        dislikedGenres: listOrNull(state?.dislikedGenres),
        pace: state?.pace ?? null,
        themesToAvoid:
          themes.length > 0 ? themes.map(([theme, sensitivity]) => ({ theme, sensitivity })) : null,
      },
      createdAt: current?.createdAt.toISOString() ?? null,
    };
  }

  async setRating(userId: string, editionId: string, rating: number): Promise<ProfileSaved> {
    await this.throttleSaves(userId);
    if (!UUID.test(editionId)) throw new ApiError('NOT_FOUND');
    await this.profiles.requireEdition(editionId);
    return saved(
      await this.profiles.save(userId, 'Rated a book', (state) => {
        state.ratings.set(editionId, { rating, origin: 'quick_rate' });
      }),
    );
  }

  async removeRating(userId: string, editionId: string): Promise<ProfileSaved> {
    await this.throttleSaves(userId);
    if (!UUID.test(editionId)) throw new ApiError('NOT_FOUND');
    return saved(
      await this.profiles.save(userId, 'Removed a rating', (state) => {
        state.ratings.delete(editionId);
      }),
    );
  }

  /** The current version's ratings, by title, in pages (CONTRACT 2: cursor pagination). */
  async ratings(userId: string, cursor: string | undefined, limit: number): Promise<RatingList> {
    const latest = await this.prisma.tasteProfileVersion.findFirst({
      where: { userId },
      orderBy: { versionNo: 'desc' },
      select: { id: true },
    });
    if (!latest) return { items: [], nextCursor: null };
    const after = decodeCursor(cursor);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        edition_id: string;
        title: string;
        rating: number;
        origin: 'quick_rate' | 'imported';
      }>
    >(
      `SELECT r.edition_id, e.title, r.rating, r.origin FROM profile_ratings r
         JOIN editions e ON e.id = r.edition_id
        WHERE r.taste_profile_version_id = $1::uuid
          AND ($2::text IS NULL OR (e.title, e.id) > ($2::text, $3::uuid))
        ORDER BY e.title, e.id
        LIMIT $4`,
      latest.id,
      after?.title ?? null,
      after?.id ?? null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const described = new Map(
      (await this.catalog.describe(page.map((r) => r.edition_id))).map((h) => [h.editionId, h]),
    );
    const last = page[page.length - 1];
    return {
      items: page.flatMap((r) => {
        const hit = described.get(r.edition_id);
        return hit ? [{ ...toCandidate(hit), rating: r.rating, origin: r.origin }] : [];
      }),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ title: last.title, id: last.edition_id })
          : null,
    };
  }

  /**
   * Books to rate (quick rate). With a query: the same search as discovery,
   * more results. Without one: the most-rated books. Each item shows the
   * reader's current rating.
   */
  async catalogSearch(
    userId: string,
    q: string | undefined,
    limit?: number,
  ): Promise<CatalogSearchResult> {
    const size = limit ?? this.config.QUICK_RATE_LIST_SIZE;
    let hits;
    let external: CatalogSearchResult['external'] = null;
    if (q && /[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(q)) {
      ({ hits, external } = await this.search.searchFor(userId, q, size));
    } else {
      hits = await this.catalog.popular(size);
    }
    const ids = hits.map((h) => h.editionId);
    const mine = new Map<string, number>();
    if (ids.length > 0) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ edition_id: string; rating: number }>>(
        `SELECT r.edition_id, r.rating FROM profile_ratings r
          WHERE r.taste_profile_version_id = (
                  SELECT id FROM taste_profile_versions WHERE user_id = $1::uuid
                   ORDER BY version_no DESC LIMIT 1)
            AND r.edition_id = ANY($2::uuid[])`,
        userId,
        ids,
      );
      for (const r of rows) mine.set(r.edition_id, r.rating);
    }
    return {
      items: hits.map((h) => ({ ...toCandidate(h), yourRating: mine.get(h.editionId) ?? null })),
      external,
    };
  }

  async questionnaireOptions(): Promise<QuestionnaireOptions> {
    const [genres, themes] = await Promise.all([
      this.prisma.genre.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
      this.prisma.theme.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
    ]);
    return {
      genres: genres.map((g) => g.name),
      themes: themes.map((t) => t.name),
      paces: [...PACES],
    };
  }

  /**
   * Replaces the questionnaire answers in a new version; ratings are kept.
   * A missing or null field is unknown and stored as nothing (ONB-3).
   */
  async saveQuestionnaire(userId: string, answers: QuestionnaireRequest): Promise<ProfileSaved> {
    await this.throttleSaves(userId);
    const options = await this.questionnaireOptions();
    const fields: Record<string, string> = {};
    const genres = new Set(options.genres);
    const themes = new Set(options.themes);
    for (const key of ['likedGenres', 'dislikedGenres'] as const) {
      const unknown = (answers[key] ?? []).filter((g) => !genres.has(g));
      if (unknown.length > 0) fields[key] = `Unknown genre: ${unknown.join(', ')}`;
    }
    const unknownThemes = (answers.themesToAvoid ?? []).filter((t) => !themes.has(t.theme));
    if (unknownThemes.length > 0) {
      fields.themesToAvoid = `Unknown theme: ${unknownThemes.map((t) => t.theme).join(', ')}`;
    }
    if (Object.keys(fields).length > 0) throw new ApiError('VALIDATION_FAILED', { fields });

    return saved(
      await this.profiles.save(userId, 'Updated the questionnaire', (state) => {
        state.likedGenres = new Set(answers.likedGenres ?? []);
        state.dislikedGenres = new Set(answers.dislikedGenres ?? []);
        state.pace = answers.pace ?? null;
        state.themesToAvoid = new Map(
          (answers.themesToAvoid ?? []).map((t) => [t.theme, t.sensitivity]),
        );
      }),
    );
  }

  /** Onboarding "Skip for now" (D-002, ONB-2). Never undoes a completed onboarding. */
  async skipOnboarding(userId: string): Promise<void> {
    if (!this.config.ONBOARDING_ALLOW_SKIP) {
      throw new ApiError('CONFLICT');
    }
    await this.prisma.user.updateMany({
      where: { id: userId, onboardingState: 'pending' },
      data: { onboardingState: 'skipped' },
    });
  }

  private async throttleSaves(userId: string): Promise<void> {
    const limit = await this.limiter.hit(`taste:user:${userId}`, {
      max: this.config.RATING_SAVES_PER_MINUTE,
      windowSeconds: 60,
    });
    if (!limit.allowed) {
      throw new ApiError('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
    }
  }
}

function saved(version: VersionSummary): ProfileSaved {
  return { tasteProfileVersion: version.versionNo, ratedCount: version.ratedCount };
}

function encodeCursor(value: { title: string; id: string }): string {
  return Buffer.from(JSON.stringify([value.title, value.id])).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { title: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [title, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof title === 'string' && typeof id === 'string' && UUID.test(id)) return { title, id };
  } catch {
    // Fall through.
  }
  throw new ApiError('VALIDATION_FAILED', { fields: { cursor: 'Invalid cursor.' } });
}
