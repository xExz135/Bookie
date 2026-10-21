import { Injectable } from '@nestjs/common';
import { AnalysisView } from '../analysis/analysis-view';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../database/prisma.service';
import type { FeedbackRequest, FeedbackSaved } from './reader-data.schemas';

/**
 * Feedback on one section of an analysis (spec 6, CONTRACT 4.5). One value
 * per reader, analysis and section; saving again replaces it (FB-1). It is
 * stored with the taste-profile version and, for the personal match, the
 * model version that produced it, as labeled data for evaluation.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly view: AnalysisView,
  ) {}

  async save(userId: string, input: FeedbackRequest): Promise<FeedbackSaved> {
    // Only the reader's own analysis; anyone else's is 404 (FB-2, SEC-1).
    const analysis = await this.view.get(userId, input.analysisId);
    if (!analysis) throw new ApiError('NOT_FOUND');
    const generated =
      input.target === 'public'
        ? analysis.publicReception.status === 'done'
        : analysis.personalMatch.status === 'done';
    if (!generated) {
      // Spec 6: feedback is hidden on sections that failed or were not generated.
      throw new ApiError('CONFLICT', {
        message: 'Feedback can only be given on a section that was generated.',
      });
    }

    const row = await this.prisma.analysis.findUniqueOrThrow({
      where: { id: input.analysisId },
      select: {
        tasteProfileVersionId: true,
        personalAnalysis: { select: { modelVersionId: true } },
      },
    });
    const versions = {
      tasteProfileVersionId: row.tasteProfileVersionId,
      modelVersionId:
        input.target === 'personal' ? (row.personalAnalysis?.modelVersionId ?? null) : null,
    };
    const saved = await this.prisma.feedback.upsert({
      where: {
        userId_analysisId_target: { userId, analysisId: input.analysisId, target: input.target },
      },
      create: {
        userId,
        analysisId: input.analysisId,
        target: input.target,
        value: input.value,
        ...versions,
      },
      update: { value: input.value, ...versions },
      select: { target: true, value: true, updatedAt: true },
    });
    return { target: saved.target, value: saved.value, updatedAt: saved.updatedAt.toISOString() };
  }
}
