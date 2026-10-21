import { Injectable } from '@nestjs/common';
import type {
  PersonalScore,
  PersonalScoreInput,
  PersonalScorer,
} from '../analysis/personal-scorer';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import type { ModelId } from '../contract/enums';
import { PrismaService } from '../database/prisma.service';
import {
  type Answers,
  type ReleaseParameters,
  avoidWeights,
  isPace,
  mean,
  scoreB0,
  scoreB1,
  scoreB2,
  scoreB3,
  scoreB4,
} from './scoring';

const MODEL_NAMES: Record<ModelId, string> = {
  B0: 'global average rating',
  B1: 'questionnaire and trait match',
  B2: 'taste vector',
  B3: 'collaborative model',
  B4: 'hybrid model',
};

interface ReleaseRow {
  id: string;
  model_id: ModelId;
  version: string;
  parameters: Record<string, unknown> & { release?: { shipped: ModelId; books: number } };
}

/** A loaded release: one row per model, and the parameters the scoring needs. */
interface LoadedRelease {
  version: string;
  shipped: ModelId;
  books: number;
  rowId: Record<ModelId, string>;
  parameters: ReleaseParameters;
  embeddingModel: string;
}

interface BookTrait {
  id: string;
  trait: 'pace' | 'tone' | 'themes' | 'contentIntensity';
  value: string;
}

/**
 * Serves the taste models (BE-13, D-006, D-024). Which model scores:
 *
 * - fewer than TASTE_MIN_RATED_FOR_CONFIDENCE rated books: a fallback, B1 when
 *   the reader answered the questionnaire, otherwise B0 (spec 7 cold start);
 * - otherwise the release's shipped model, for a book it knows;
 * - a book it does not know: B2 when the book and at least TASTE_HARD_FLOOR of
 *   the reader's books have embeddings, otherwise the fallback.
 *
 * Fallbacks and books outside the release always have low confidence. The
 * pipeline has already handled readers below the hard floor (MODEL-4).
 */
@Injectable()
export class TasteModelScorer implements PersonalScorer {
  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async available(): Promise<boolean> {
    return (await this.release()) !== null;
  }

  /** The pinned version (TASTE_MODEL_VERSION), else the release of the shipped model. */
  private async release(): Promise<LoadedRelease | null> {
    const pinned = this.config.TASTE_MODEL_VERSION;
    const rows = await this.prisma.$queryRawUnsafe<ReleaseRow[]>(
      `SELECT id, model_id, version, parameters FROM model_versions
        WHERE version = COALESCE(NULLIF($1, ''),
              (SELECT version FROM model_versions WHERE is_shipped ORDER BY created_at DESC LIMIT 1))`,
      pinned,
    );
    if (rows.length !== 5) return null;
    const by = Object.fromEntries(rows.map((r) => [r.model_id, r])) as Record<ModelId, ReleaseRow>;
    const info = by.B0.parameters.release;
    if (!info) return null;
    const strip = (r: ReleaseRow) => {
      const { release: _release, ...rest } = r.parameters;
      return rest;
    };
    return {
      version: rows[0]!.version,
      shipped: info.shipped,
      books: info.books,
      rowId: Object.fromEntries(rows.map((r) => [r.model_id, r.id])) as Record<ModelId, string>,
      parameters: {
        B0: strip(by.B0),
        B1: strip(by.B1),
        B2: strip(by.B2),
        B3: strip(by.B3),
        B4: strip(by.B4),
      } as unknown as ReleaseParameters,
      embeddingModel: (by.B2.parameters as { embeddingModel: string }).embeddingModel,
    };
  }

  async score(input: PersonalScoreInput): Promise<PersonalScore | null> {
    const release = await this.release();
    if (!release) return null;
    const p = release.parameters;
    const min = this.config.TASTE_MIN_RATED_FOR_CONFIDENCE;

    const profile = (
      await this.prisma.$queryRawUnsafe<Array<{ edition_id: string; rating: number }>>(
        `SELECT edition_id, rating FROM profile_ratings
          WHERE taste_profile_version_id = $1::uuid ORDER BY edition_id`,
        input.tasteProfileVersionId,
      )
    ).map((r) => ({ editionId: r.edition_id, rating: Number(r.rating) }));
    const answers = await this.answers(input.tasteProfileVersionId);
    const answered =
      answers.likedGenres.length > 0 ||
      answers.dislikedGenres.length > 0 ||
      answers.pace !== null ||
      answers.themesToAvoid.length > 0;
    const n = profile.length;
    const ids = [input.editionId, ...profile.map((r) => r.editionId)];

    const biasRows = await this.prisma.$queryRawUnsafe<
      Array<{ edition_id: string; item_bias: number }>
    >(
      `SELECT edition_id, item_bias FROM model_item_stats
        WHERE model_version_id = $1::uuid AND edition_id = ANY($2::uuid[])`,
      release.rowId.B3,
      ids,
    );
    const bias = new Map(biasRows.map((r) => [r.edition_id, Number(r.item_bias)]));
    const embeddings = await this.embeddings(release.embeddingModel, ids);
    const known = bias.has(input.editionId);
    const embeddedProfile = profile.filter((r) => embeddings.has(r.editionId)).length;

    const fallback: ModelId = answered ? 'B1' : 'B0';
    let model: ModelId;
    if (n < min) model = fallback;
    else if (known) model = release.shipped;
    else if (embeddings.has(input.editionId) && embeddedProfile >= this.config.TASTE_HARD_FLOOR)
      model = 'B2';
    else model = fallback;

    const traits = await this.bookTraits(input.publicAnalysisId);
    const readerMean = mean(profile.map((r) => r.rating));
    const knownProfile = profile.filter((r) => bias.has(r.editionId));
    const sims = await this.similarities(release.rowId.B3, input.editionId, knownProfile);

    const b2 = () =>
      scoreB2(
        p,
        profile.map((r) => ({ rating: r.rating, embedding: embeddings.get(r.editionId) ?? null })),
        embeddings.get(input.editionId) ?? null,
      );
    const b3 = () =>
      scoreB3(p, {
        profile: knownProfile.map((r) => ({
          rating: r.rating,
          itemBias: bias.get(r.editionId)!,
          similarity: sims.get(r.editionId) ?? 0,
        })),
        targetBias: bias.get(input.editionId) ?? 0,
      });
    let score: number;
    switch (model) {
      case 'B0':
        score = scoreB0(p, bias.get(input.editionId));
        break;
      case 'B1':
        score = scoreB1(p, answers, readerMean, {
          genreShares: await this.genreShares(input.editionId),
          pace: traits.find((t) => t.trait === 'pace')?.value ?? null,
          themes: traits.filter((t) => t.trait === 'themes').map((t) => t.value),
        });
        break;
      case 'B2':
        score = b2();
        break;
      case 'B3':
        score = b3();
        break;
      case 'B4':
        score = scoreB4(p, b2(), b3());
        break;
    }

    return {
      modelVersionId: release.rowId[model],
      modelId: model,
      score: Math.round(score * 100) / 100,
      confidence: this.confidence(model, release, {
        n,
        known,
        knownCount: knownProfile.length,
        embeddedProfile,
      }),
      similarBooks: this.similarBooks(model, profile, sims, embeddings, input.editionId),
      traitFits: this.traitFits(p, answers, traits),
    };
  }

  /** Evidence confidence of the personal match, in code (spec 4, D-024). */
  private confidence(
    model: ModelId,
    release: LoadedRelease,
    c: { n: number; known: boolean; knownCount: number; embeddedProfile: number },
  ): PersonalScore['confidence'] {
    const min = this.config.TASTE_MIN_RATED_FOR_CONFIDENCE;
    const rated = `${c.n} rated book${c.n === 1 ? '' : 's'}`;
    if (model === 'B0' || model === 'B1') {
      return {
        level: 'low',
        reasons: [
          c.n < min
            ? `${rated}; ${min} are needed for a confident match`
            : `This book is not among the ${release.books} books the learned model knows`,
          `Scored by the ${MODEL_NAMES[model]} (${model}), not the learned model`,
        ],
      };
    }
    if (!c.known) {
      return {
        level: 'low',
        reasons: [
          rated,
          `This book is not among the ${release.books} books the learned model knows, so only its description and reviews were compared with your rated books (${model})`,
        ],
      };
    }
    const used = model === 'B2' ? c.embeddedProfile : c.knownCount;
    const level =
      used >= this.config.PERSONAL_CONFIDENCE_HIGH_RATINGS
        ? 'high'
        : used >= min
          ? 'medium'
          : 'low';
    const reasons = [rated];
    if (used < c.n) reasons.push(`${used} of them are among the books the model knows`);
    if (level === 'low')
      reasons.push(`${min} rated books the model knows are needed for a confident match`);
    return { level, reasons };
  }

  /** The reader's rated books closest to this one by the model's own similarity. */
  private similarBooks(
    model: ModelId,
    profile: Array<{ editionId: string; rating: number }>,
    sims: Map<string, number>,
    embeddings: Map<string, number[]>,
    target: string,
  ): PersonalScore['similarBooks'] {
    let scored: Array<{ editionId: string; yourRating: number; similarity: number }> = [];
    if (model === 'B3' || model === 'B4') {
      scored = profile.flatMap((r) => {
        const s = sims.get(r.editionId);
        return s && s > 0 ? [{ editionId: r.editionId, yourRating: r.rating, similarity: s }] : [];
      });
    } else if (model === 'B2') {
      const t = embeddings.get(target);
      scored = profile.flatMap((r) => {
        const e = embeddings.get(r.editionId);
        if (!t || !e) return [];
        let dot = 0;
        for (let i = 0; i < t.length; i++) dot += t[i]! * e[i]!;
        return dot > 0 ? [{ editionId: r.editionId, yourRating: r.rating, similarity: dot }] : [];
      });
    }
    return scored
      .sort((a, b) => b.similarity - a.similarity || a.editionId.localeCompare(b.editionId))
      .slice(0, this.config.PERSONAL_SIMILAR_BOOKS)
      .map((s) => ({ ...s, similarity: Math.round(s.similarity * 1e5) / 1e5 }));
  }

  /**
   * The book's traits against the reader's questionnaire. Pace is aligned or
   * conflicting when both are known; an avoided theme the book has conflicts.
   * Everything else is not factored in (`unknown`), linked to the book's trait
   * when it has one. Unknown preferences never change a score (MODEL-2).
   */
  private traitFits(
    p: ReleaseParameters,
    answers: Answers,
    traits: BookTrait[],
  ): PersonalScore['traitFits'] {
    const fits: PersonalScore['traitFits'] = [];
    const pace = traits.find((t) => t.trait === 'pace');
    if (pace && isPace(pace.value) && isPace(answers.pace))
      fits.push({
        trait: 'pace',
        fit: pace.value === answers.pace ? 'aligned' : 'conflicting',
        bookTraitId: pace.id,
      });
    else fits.push({ trait: 'pace', fit: 'unknown', bookTraitId: pace?.id ?? null });

    for (const key of ['tone', 'contentIntensity'] as const) {
      const rows = traits.filter((t) => t.trait === key);
      if (rows.length === 0) fits.push({ trait: key, fit: 'unknown', bookTraitId: null });
      for (const t of rows) fits.push({ trait: key, fit: 'unknown', bookTraitId: t.id });
    }

    const avoid = avoidWeights(p, answers);
    const themes = traits.filter((t) => t.trait === 'themes');
    for (const t of themes.filter((t) => avoid.has(t.value)))
      fits.push({ trait: 'themes', fit: 'conflicting', bookTraitId: t.id });
    if (answers.themesToAvoid.length === 0) {
      if (themes.length === 0) fits.push({ trait: 'themes', fit: 'unknown', bookTraitId: null });
      for (const t of themes) fits.push({ trait: 'themes', fit: 'unknown', bookTraitId: t.id });
    }
    return fits;
  }

  private async answers(tasteProfileVersionId: string): Promise<Answers> {
    const version = await this.prisma.tasteProfileVersion.findUniqueOrThrow({
      where: { id: tasteProfileVersionId },
      select: {
        pace: true,
        genrePreferences: { select: { preference: true, genre: { select: { name: true } } } },
        themeAvoidances: { select: { sensitivity: true, theme: { select: { name: true } } } },
      },
    });
    return {
      likedGenres: version.genrePreferences
        .filter((g) => g.preference === 'liked')
        .map((g) => g.genre.name),
      dislikedGenres: version.genrePreferences
        .filter((g) => g.preference === 'disliked')
        .map((g) => g.genre.name),
      pace: version.pace,
      themesToAvoid: version.themeAvoidances.map((t) => ({
        theme: t.theme.name,
        sensitivity: t.sensitivity,
      })),
    };
  }

  private async embeddings(model: string, ids: string[]): Promise<Map<string, number[]>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ edition_id: string; embedding: string }>
    >(
      `SELECT edition_id, embedding::text AS embedding FROM book_embeddings
        WHERE embedding_model = $1 AND edition_id = ANY($2::uuid[])`,
      model,
      ids,
    );
    return new Map(rows.map((r) => [r.edition_id, JSON.parse(r.embedding) as number[]]));
  }

  private async similarities(
    b3RowId: string,
    target: string,
    profile: Array<{ editionId: string }>,
  ): Promise<Map<string, number>> {
    if (profile.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ neighbour_id: string; similarity: number }>
    >(
      `SELECT neighbour_id, similarity FROM model_item_neighbours
        WHERE model_version_id = $1::uuid AND edition_id = $2::uuid AND neighbour_id = ANY($3::uuid[])`,
      b3RowId,
      target,
      profile.map((r) => r.editionId),
    );
    return new Map(rows.map((r) => [r.neighbour_id, Number(r.similarity)]));
  }

  private async genreShares(editionId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ name: string; votes: number }>>(
      `SELECT g.name, eg.votes FROM edition_genres eg JOIN genres g ON g.id = eg.genre_id
        WHERE eg.edition_id = $1::uuid`,
      editionId,
    );
    const total = rows.reduce((sum, r) => sum + Number(r.votes), 0);
    return Object.fromEntries(rows.map((r) => [r.name, total > 0 ? Number(r.votes) / total : 0]));
  }

  private async bookTraits(publicAnalysisId: string | null): Promise<BookTrait[]> {
    if (!publicAnalysisId) return [];
    const rows = await this.prisma.bookTrait.findMany({
      where: { publicAnalysisId },
      select: { id: true, trait: true, value: true },
      orderBy: { value: 'asc' },
    });
    return rows as BookTrait[];
  }
}
