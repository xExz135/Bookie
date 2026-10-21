import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { RateLimiter } from '../redis/rate-limiter';
import type { Analysis, AnalysisSummary } from './analysis.schemas';
import { STEP_ORDER, type StepName } from './analysis.types';
import { AnalysisRunner } from './analysis-runner';
import { AnalysisView } from './analysis-view';
import { PERSONAL_SCORER, type PersonalScorer } from './personal-scorer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CONTRACT 4.4 endpoints. Every query is scoped to the signed-in reader;
 * another reader's analysis is 404, never 403 (SEC-1).
 */
@Injectable()
export class AnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
    private readonly limiter: RateLimiter,
    private readonly runner: AnalysisRunner,
    private readonly view: AnalysisView,
    @Inject(PERSONAL_SCORER) private readonly scorer: PersonalScorer,
  ) {}

  /**
   * Starts an analysis of the edition for the reader's current taste
   * profile, or joins the one already running for the same edition and
   * profile version (spec 10: duplicates join, never duplicate).
   */
  async start(
    userId: string,
    editionId: string,
  ): Promise<{ analysis: Analysis; created: boolean }> {
    await this.checkRate(userId);
    const edition = await this.prisma.edition.findUnique({
      where: { id: editionId },
      select: { id: true },
    });
    if (!edition) throw new ApiError('NOT_FOUND', { message: 'Unknown edition.' });
    const version = await this.currentVersion(userId);
    return this.create(userId, editionId, version?.id ?? null, null);
  }

  async get(userId: string, analysisId: string): Promise<Analysis> {
    const analysis = UUID.test(analysisId) ? await this.view.get(userId, analysisId) : null;
    if (!analysis) throw new ApiError('NOT_FOUND');
    return analysis;
  }

  /** History, newest first. A cursor or limit that cannot be read falls back to the default. */
  async list(
    userId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{ items: AnalysisSummary[]; nextCursor: string | null }> {
    const size = Number.isInteger(limit) && limit! >= 1 ? Math.min(limit!, 50) : 20;
    const after = decodeCursor(cursor);
    const rows = await this.prisma.analysis.findMany({
      where: {
        userId,
        ...(after && {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: { id: true, createdAt: true },
    });
    const page = rows.slice(0, size);
    const items: AnalysisSummary[] = [];
    for (const row of page) {
      const full = await this.view.get(userId, row.id);
      if (full) items.push(this.view.toSummary(full));
    }
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > size && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * Runs failed steps again; done steps are never repeated (RES-2). Steps
   * skipped because of a failure run again too, then the overall status.
   */
  async retry(
    userId: string,
    analysisId: string,
    requested: StepName[] | undefined,
  ): Promise<Analysis> {
    const analysis = UUID.test(analysisId)
      ? await this.prisma.analysis.findFirst({
          where: { id: analysisId, userId },
          include: { steps: true },
        })
      : null;
    if (!analysis) throw new ApiError('NOT_FOUND');
    if (analysis.status === 'running' || this.runner.isBusy(analysisId)) {
      throw new ApiError('CONFLICT', { message: 'The analysis is still running.' });
    }
    const modelReady = await this.scorer.available();
    const retryable = analysis.steps.filter(
      (s) => s.status === 'failed' && (s.errorCode !== 'MODEL_UNAVAILABLE' || modelReady),
    );
    const failedNames = new Set(
      analysis.steps.filter((s) => s.status === 'failed').map((s) => s.step as StepName),
    );
    if (requested) {
      const notFailed = requested.filter((name) => !failedNames.has(name));
      if (notFailed.length > 0) {
        throw new ApiError('VALIDATION_FAILED', {
          fields: {
            steps: `Only failed steps can be retried: ${notFailed.join(', ')} did not fail.`,
          },
        });
      }
    }
    const chosen = retryable.filter((s) => !requested || requested.includes(s.step as StepName));
    if (chosen.length === 0) throw new ApiError('CONFLICT', { message: 'Nothing to retry.' });
    await this.checkRate(userId);

    try {
      await this.prisma.$transaction([
        this.prisma.analysisStep.updateMany({
          where: {
            analysisId,
            OR: [
              { step: { in: chosen.map((s) => s.step) } },
              { status: 'skipped' },
              { step: 'finalize' },
            ],
          },
          data: { status: 'pending', errorCode: null },
        }),
        this.prisma.analysis.update({
          where: { id: analysisId },
          data: { status: 'running', finishedAt: null },
        }),
      ]);
    } catch {
      // Another analysis of this book for the same profile is running (one at a time).
      throw new ApiError('CONFLICT', { message: 'An analysis of this book is already running.' });
    }
    this.runner.enqueue(analysisId);
    return this.get(userId, analysisId);
  }

  /** A new analysis for the current taste profile; the old one stays unchanged (spec 10, ONB-4). */
  async recalculate(userId: string, analysisId: string): Promise<Analysis> {
    const analysis = UUID.test(analysisId)
      ? await this.prisma.analysis.findFirst({ where: { id: analysisId, userId } })
      : null;
    if (!analysis) throw new ApiError('NOT_FOUND');
    const version = await this.currentVersion(userId);
    if ((version?.id ?? null) === analysis.tasteProfileVersionId) {
      throw new ApiError('CONFLICT', {
        message: 'This analysis already uses your current taste profile.',
      });
    }
    await this.checkRate(userId);
    const { analysis: created } = await this.create(
      userId,
      analysis.editionId,
      version?.id ?? null,
      analysis.id,
    );
    return created;
  }

  private async create(
    userId: string,
    editionId: string,
    tasteProfileVersionId: string | null,
    recalculatedFromId: string | null,
  ): Promise<{ analysis: Analysis; created: boolean }> {
    const running = () =>
      this.prisma.analysis.findFirst({
        where: { userId, editionId, tasteProfileVersionId, status: 'running' },
        select: { id: true },
      });
    const existing = await running();
    if (existing) return { analysis: await this.get(userId, existing.id), created: false };

    let id: string;
    try {
      ({ id } = await this.prisma.analysis.create({
        data: {
          userId,
          editionId,
          tasteProfileVersionId,
          recalculatedFromId,
          steps: { create: STEP_ORDER.map((step) => ({ step })) },
        },
        select: { id: true },
      }));
    } catch (error) {
      // Two requests at once: the unique index lets one in; the other joins it.
      const joined = await running();
      if (!joined) throw error;
      return { analysis: await this.get(userId, joined.id), created: false };
    }
    this.runner.enqueue(id);
    return { analysis: await this.get(userId, id), created: true };
  }

  private currentVersion(userId: string) {
    return this.prisma.tasteProfileVersion.findFirst({
      where: { userId },
      orderBy: { versionNo: 'desc' },
      select: { id: true },
    });
  }

  /** Starting, retrying and recalculating share one hourly limit per reader (spec 12). */
  private async checkRate(userId: string): Promise<void> {
    const limit = await this.limiter.hit(`analyses:user:${userId}`, {
      max: this.config.RATE_LIMIT_ANALYSES_PER_HOUR,
      windowSeconds: 3600,
    });
    if (!limit.allowed)
      throw new ApiError('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor || cursor.length > 200) return null;
  const [time, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(time ?? '');
  return id && UUID.test(id) && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}
