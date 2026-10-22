import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { LlmUsage } from '../llm/gemini.client';
import type { SourceRating } from '../sources/rating-sources.service';

/** How one model request ended (D-026). Client errors use their `LlmError.kind`. */
export type LlmCallOutcome = 'ok' | 'invalid_output' | string;

export interface RecordedLlmCall {
  usage: LlmUsage;
  outcome: LlmCallOutcome;
}

/**
 * Model attempts of one step as calls: every attempt but the last was refused
 * by our checks; the last one is `last` (spec 8: invalid output is retried once).
 */
export function attemptsAsCalls(usage: LlmUsage[], last: LlmCallOutcome): RecordedLlmCall[] {
  return usage.map((u, i) => ({
    usage: u,
    outcome: i === usage.length - 1 ? last : 'invalid_output',
  }));
}

/**
 * Stores what each analysis cost and how its sources answered (H4, spec 12,
 * D-026), for the cost and latency report. Recording is best effort: a
 * failure here is logged and never fails the analysis.
 */
@Injectable()
export class UsageRecorder {
  private readonly logger = new Logger('UsageRecorder');

  constructor(private readonly prisma: PrismaService) {}

  async llmCalls(
    analysisId: string,
    editionId: string,
    purpose: string,
    calls: RecordedLlmCall[],
  ): Promise<void> {
    if (calls.length === 0) return;
    await this.safely('model calls', () =>
      this.prisma.llmCall.createMany({
        data: calls.map(({ usage, outcome }) => ({
          analysisId,
          editionId,
          purpose,
          model: usage.model,
          outcome,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          latencyMs: Math.round(usage.latencyMs),
          waitedMs: Math.round(usage.waitedMs),
        })),
      }),
    );
  }

  /** The live sources' answers; the dataset is not a call and is not recorded. */
  async sourceCalls(analysisId: string, editionId: string, answers: SourceRating[]): Promise<void> {
    if (answers.length === 0) return;
    await this.safely('source answers', () =>
      this.prisma.sourceCall.createMany({
        data: answers.map((a) => ({
          analysisId,
          editionId,
          sourceKey: a.key,
          outcome: a.outcome,
          detail: a.detail,
          cached: a.cached === true,
          durationMs: Math.round(a.durationMs),
        })),
      }),
    );
  }

  private async safely(what: string, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(`Could not record ${what}: ${(error as Error).message}`);
    }
  }
}
