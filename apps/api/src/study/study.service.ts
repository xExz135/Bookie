import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import type { ModelId } from '../contract/enums';
import { PrismaService } from '../database/prisma.service';
import { CatalogSearch } from '../discovery/catalog-search';
import { toCandidate } from '../discovery/discovery.schemas';
import { Prisma } from '../generated/prisma/client';
import { TasteModelScorer } from '../taste-models/taste-model.scorer';
import type { Study } from './study.schemas';

/**
 * The user study (spec 9, FE-10, D-027). A reader with enough rated books
 * joins; STUDY_HELD_OUT_BOOKS of their rated books that the learned model
 * knows are held out at random, and the shipped model predicts each from the
 * other ratings only, next to B0. Everything is stored when the reader joins
 * and never changes afterwards. Scores are computed in code (D-006).
 */
@Injectable()
export class StudyService {
  private readonly logger = new Logger('Study');

  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
    private readonly scorer: TasteModelScorer,
    private readonly catalog: CatalogSearch,
  ) {}

  async get(userId: string): Promise<Study> {
    const participant = await this.prisma.studyParticipant.findUnique({
      where: { userId },
      include: { predictions: { orderBy: { position: 'asc' } } },
    });
    const profile = await this.profile(userId);
    const base = {
      requirements: {
        minRatedBooks: this.config.STUDY_MIN_RATED_BOOKS,
        heldOutBooks: this.config.STUDY_HELD_OUT_BOOKS,
      },
      ratedCount: profile.ratings.length,
      knownCount: profile.known?.size ?? 0,
      scale: { min: 1 as const, max: 5 as const },
    };
    if (!participant) {
      const reason = this.ineligible(profile);
      return {
        ...base,
        status: reason ? 'not_eligible' : 'eligible',
        ineligibleReason: reason,
        joinedAt: null,
        modelVersion: null,
        heldOut: [],
      };
    }

    const ids = participant.predictions.map((p) => p.editionId);
    const versionIds = [
      ...new Set(
        participant.predictions.flatMap((p) => [p.modelVersionId, p.baselineModelVersionId]),
      ),
    ];
    const [described, versions] = await Promise.all([
      this.catalog.describe(ids),
      this.prisma.modelVersion.findMany({
        where: { id: { in: versionIds } },
        select: { id: true, modelId: true, version: true },
      }),
    ]);
    const editions = new Map(described.map((hit) => [hit.editionId, toCandidate(hit)]));
    const versionOf = new Map(versions.map((v) => [v.id, v]));
    return {
      ...base,
      status: 'joined',
      ineligibleReason: null,
      joinedAt: participant.consentedAt.toISOString(),
      modelVersion: versionOf.get(participant.predictions[0]!.modelVersionId)?.version ?? null,
      heldOut: participant.predictions.flatMap((p) => {
        const edition = editions.get(p.editionId);
        if (!edition) return [];
        return [
          {
            edition,
            yourRating: p.actualRating,
            prediction: {
              score: Number(p.score),
              modelId: versionOf.get(p.modelVersionId)!.modelId as ModelId,
              confidence: p.confidence,
            },
            baseline: { score: Number(p.baselineScore), modelId: 'B0' as const },
          },
        ];
      }),
    };
  }

  /**
   * Joins the study (consent given). Joining again returns the participation
   * as it is (`created: false`); a reader who is not eligible gets CONFLICT.
   */
  async join(userId: string): Promise<{ study: Study; created: boolean }> {
    if (await this.prisma.studyParticipant.findUnique({ where: { userId } })) {
      return { study: await this.get(userId), created: false };
    }
    const profile = await this.profile(userId);
    const reason = this.ineligible(profile);
    if (reason || !profile.versionId || !profile.known) {
      throw new ApiError('CONFLICT', { message: STUDY_REFUSALS[reason ?? 'no_model'] });
    }

    const participantId = randomUUID();
    const heldOut = this.chooseHeldOut(
      participantId,
      profile.ratings.filter((r) => profile.known!.has(r.editionId)),
    );
    const exclude = heldOut.map((r) => r.editionId);
    const predictions: Prisma.StudyPredictionCreateManyParticipantInput[] = [];
    for (const [i, r] of heldOut.entries()) {
      const [scored, baseline] = await Promise.all([
        this.scorer.score({
          userId,
          editionId: r.editionId,
          tasteProfileVersionId: profile.versionId,
          publicAnalysisId: null,
          excludeEditionIds: exclude,
        }),
        this.scorer.baseline(r.editionId),
      ]);
      if (!scored || !baseline) {
        throw new ApiError('CONFLICT', { message: STUDY_REFUSALS.no_model });
      }
      predictions.push({
        editionId: r.editionId,
        position: i + 1,
        actualRating: r.rating,
        modelVersionId: scored.modelVersionId,
        score: new Prisma.Decimal(scored.score.toFixed(2)),
        confidence: scored.confidence.level,
        baselineModelVersionId: baseline.modelVersionId,
        baselineScore: new Prisma.Decimal(baseline.score.toFixed(2)),
      });
    }
    try {
      await this.prisma.studyParticipant.create({
        data: {
          id: participantId,
          userId,
          tasteProfileVersionId: profile.versionId,
          ratedCount: profile.ratings.length,
          consentedAt: new Date(),
          predictions: { createMany: { data: predictions } },
        },
      });
    } catch (error) {
      // Joined at the same moment from another request: show that participation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { study: await this.get(userId), created: false };
      }
      throw error;
    }
    this.logger.log(`A reader joined the user study (${heldOut.length} held-out books)`);
    return { study: await this.get(userId), created: true };
  }

  /** Leaves the study: the participation and its predictions are deleted. */
  async leave(userId: string): Promise<void> {
    await this.prisma.studyParticipant.deleteMany({ where: { userId } });
  }

  /**
   * The held-out books: a seeded shuffle of the eligible ratings by a hash of
   * the participant and the book, so the choice is random for the reader and
   * reproducible from the stored rows.
   */
  private chooseHeldOut(
    participantId: string,
    eligible: Array<{ editionId: string; rating: number }>,
  ): Array<{ editionId: string; rating: number }> {
    const key = (editionId: string) =>
      createHash('sha256').update(`${participantId}:${editionId}`).digest('hex');
    return [...eligible]
      .sort((a, b) => key(a.editionId).localeCompare(key(b.editionId)))
      .slice(0, this.config.STUDY_HELD_OUT_BOOKS);
  }

  private ineligible(profile: Profile): Study['ineligibleReason'] {
    if (!profile.known) return 'no_model';
    if (profile.ratings.length < this.config.STUDY_MIN_RATED_BOOKS) return 'too_few_ratings';
    if (profile.known.size < this.config.STUDY_HELD_OUT_BOOKS) return 'too_few_known_books';
    return null;
  }

  /** The current taste profile's ratings, and which of the books the model knows. */
  private async profile(userId: string): Promise<Profile> {
    const version = await this.prisma.tasteProfileVersion.findFirst({
      where: { userId },
      orderBy: { versionNo: 'desc' },
      select: { id: true, ratings: { select: { editionId: true, rating: true } } },
    });
    const ratings = (version?.ratings ?? []).map((r) => ({
      editionId: r.editionId,
      rating: Number(r.rating),
    }));
    const known = await this.scorer.knownBooks(ratings.map((r) => r.editionId));
    return { versionId: version?.id ?? null, ratings, known };
  }
}

interface Profile {
  versionId: string | null;
  ratings: Array<{ editionId: string; rating: number }>;
  /** Null when no model is loaded. */
  known: Set<string> | null;
}

const STUDY_REFUSALS: Record<NonNullable<Study['ineligibleReason']>, string> = {
  too_few_ratings: 'Rate more books before joining the study.',
  too_few_known_books: 'Not enough of your rated books are known to the model yet.',
  no_model: 'Personal matching is not available yet.',
};
