import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { AnalysisPipeline } from './analysis-pipeline';

/**
 * Runs analyses in the background of the API process (D-021). A request
 * starts an analysis and returns at once; the reader polls. Nothing is tied
 * to the request, so leaving the page never cancels an analysis (RES-1).
 *
 * At most ANALYSIS_MAX_CONCURRENT run at once; the rest wait in order. On
 * start-up, analyses that were running when the process stopped are resumed
 * from their first unfinished step (a step cut off mid-way runs again).
 */
@Injectable()
export class AnalysisRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger('AnalysisRunner');
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly pipeline: AnalysisPipeline,
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Test apps share one database: one must never pick up another's analyses.
    if (!this.config.ANALYSIS_RECOVER_ON_START || this.config.NODE_ENV === 'test') return;
    try {
      const resumed = await this.recover();
      if (resumed > 0) this.logger.log(`Resuming ${resumed} analyses left running`);
    } catch (error) {
      // The database may not be up yet (e.g. when only generating OpenAPI).
      this.logger.warn(`Could not resume analyses: ${(error as Error).message}`);
    }
  }

  /** Requeues every running analysis; steps cut off while running start again. */
  async recover(): Promise<number> {
    const running = await this.prisma.analysis.findMany({
      where: { status: 'running' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (running.length === 0) return 0;
    await this.prisma.analysisStep.updateMany({
      where: { analysisId: { in: running.map((a) => a.id) }, status: 'running' },
      data: { status: 'pending' },
    });
    for (const { id } of running) this.enqueue(id);
    return running.length;
  }

  /**
   * The pipeline itself broke (e.g. the database went away mid-step): mark
   * the analysis failed so it is never stuck as running, and can be retried.
   */
  private async abandon(analysisId: string): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.analysisStep.updateMany({
          where: { analysisId, status: 'running' },
          data: { status: 'failed', errorCode: 'INTERNAL_ERROR', finishedAt: new Date() },
        }),
        this.prisma.analysisStep.updateMany({
          where: { analysisId, status: 'pending' },
          data: { status: 'skipped' },
        }),
        this.prisma.analysis.updateMany({
          where: { id: analysisId, status: 'running' },
          data: { status: 'failed', finishedAt: new Date() },
        }),
      ]);
    } catch (error) {
      // Resumed on the next start-up instead (recover).
      this.logger.error(
        `Could not mark analysis ${analysisId} failed: ${(error as Error).message}`,
      );
    }
  }

  enqueue(analysisId: string): void {
    if (this.active.has(analysisId) || this.queue.includes(analysisId)) return;
    this.queue.push(analysisId);
    this.pump();
  }

  /** True while the analysis is queued or running in this process. */
  isBusy(analysisId: string): boolean {
    return this.active.has(analysisId) || this.queue.includes(analysisId);
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  idle(): Promise<void> {
    if (this.active.size === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private pump(): void {
    while (this.active.size < this.config.ANALYSIS_MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.active.add(id);
      void this.pipeline
        .run(id)
        .catch(async (error: unknown) => {
          this.logger.error(`Analysis ${id} stopped: ${(error as Error).stack ?? String(error)}`);
          await this.abandon(id);
        })
        .finally(() => {
          this.active.delete(id);
          this.pump();
          if (this.active.size === 0 && this.queue.length === 0) {
            for (const resolve of this.waiters.splice(0)) resolve();
          }
        });
    }
  }
}
