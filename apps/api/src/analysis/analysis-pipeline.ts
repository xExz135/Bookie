import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import type { ErrorCode } from '../contract/error-codes';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { type GeminiClient, LlmError, type LlmUsage } from '../llm/gemini.client';
import { UsageRecorder, attemptsAsCalls } from '../observability/usage-recorder';
import { EditionEvidenceRepository } from '../representation/edition-evidence.repository';
import {
  type SelectedReview,
  selectEvidence,
  sentimentOf,
  truncate,
} from '../representation/evidence-selection';
import { selectionOptions } from '../representation/representation-config';
import {
  DESCRIPTION_EVIDENCE,
  type ExtractedTraits,
  TRAIT_PROMPT_VERSION,
  TraitExtractionError,
  extractTraits,
} from '../representation/traits';
import { RatingSourcesService } from '../sources/rating-sources.service';
import {
  type ConfidenceOutput,
  type FetchOutput,
  PUBLIC_STEPS,
  type PersonalOutput,
  type ResolveOutput,
  STEP_ORDER,
  type SelectOutput,
  StepError,
  type StepName,
  type StoredSource,
  type SummaryOutput,
  type TraitsOutput,
} from './analysis.types';
import { evidenceStateOf, publicConfidence } from './evidence-confidence';
import { SUMMARY_PROMPT_VERSION, SummaryError, generateSummary } from './public-summary';
import { PERSONAL_SCORER, type PersonalScorer } from './personal-scorer';

export const ANALYSIS_LLM = Symbol('ANALYSIS_LLM');
export const DATASET_SOURCE_KEY = 'goodreads_dataset';

type Llm = Pick<GeminiClient, 'generateJson'>;
type Outputs = Partial<Record<StepName, unknown>>;

interface EditionInfo {
  id: string;
  title: string;
  description: string | null;
  authors: string[];
}

interface Context {
  analysisId: string;
  userId: string;
  editionId: string;
  tasteProfileVersionId: string | null;
  publicAnalysisId: string | null;
  /** The reader asked for a new public build (spec 10 user refresh). */
  refresh: boolean;
  createdAt: Date;
  edition: EditionInfo;
  outputs: Outputs;
}

/** The public steps that build a public analysis (after `resolve`). */
const BUILD_STEPS: readonly StepName[] = PUBLIC_STEPS.slice(1);

const HOUR = 3_600_000;

/**
 * The analysis pipeline (spec 8, D-021). Eight steps, each with its own
 * status and stored output (RES-2). A failed step marks the steps that need
 * it as skipped; `finalize` always runs and sets the overall status. Running
 * the pipeline again continues from the first pending step, so a retry never
 * repeats a done step and a restart resumes where it stopped (RES-1).
 *
 * Computed in code, never by the language model: evidence state, confidence,
 * citation checks and the overall status.
 */
@Injectable()
export class AnalysisPipeline {
  private readonly logger = new Logger('Analysis');
  private readonly evidence: EditionEvidenceRepository;

  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
    private readonly ratingSources: RatingSourcesService,
    @Inject(ANALYSIS_LLM) private readonly llm: Llm,
    @Inject(PERSONAL_SCORER) private readonly scorer: PersonalScorer,
    private readonly recorder: UsageRecorder,
  ) {
    // The repository takes a pg-style pool; Prisma runs the same SQL.
    const pool = {
      query: async (text: string, params: unknown[] = []) => ({
        rows: await this.prisma.$queryRawUnsafe(text, ...params),
      }),
    } as unknown as Pool;
    this.evidence = new EditionEvidenceRepository(pool);
  }

  /** Runs every pending step in order, then the overall status. Safe to call again. */
  async run(analysisId: string): Promise<void> {
    for (;;) {
      const steps = await this.prisma.analysisStep.findMany({ where: { analysisId } });
      const byName = new Map(steps.map((s) => [s.step as StepName, s]));
      const next = STEP_ORDER.find((name) => byName.get(name)?.status === 'pending');
      if (!next) return;
      // Traits and the summary read the same evidence and not each other: run them
      // together, which roughly halves the model time of a cold analysis (blocker 7).
      if (
        next === 'extractTraits' &&
        this.config.ANALYSIS_PARALLEL_MODEL_STEPS &&
        byName.get('publicSummary')?.status === 'pending'
      ) {
        await Promise.all([
          this.runStep(analysisId, 'extractTraits'),
          this.runStep(analysisId, 'publicSummary'),
        ]);
        continue;
      }
      await this.runStep(analysisId, next);
    }
  }

  private async runStep(analysisId: string, name: StepName): Promise<void> {
    const started = Date.now();
    await this.prisma.analysisStep.update({
      where: { analysisId_step: { analysisId, step: name } },
      data: {
        status: 'running',
        startedAt: new Date(),
        attemptCount: { increment: 1 },
        errorCode: null,
      },
    });
    let output: unknown = null;
    let errorCode: ErrorCode | null = null;
    try {
      const ctx = await this.context(analysisId);
      output = await this.handlers[name](ctx);
    } catch (error) {
      errorCode = this.errorCodeOf(error, name, analysisId);
      if (error instanceof StepError) output = error.output;
    }
    const durationMs = Date.now() - started;
    await this.prisma.$transaction(async (tx) => {
      await tx.analysisStep.update({
        where: { analysisId_step: { analysisId, step: name } },
        data: {
          status: errorCode ? 'failed' : 'done',
          errorCode,
          output: output === null ? Prisma.JsonNull : (output as Prisma.InputJsonValue),
          durationMs,
          finishedAt: new Date(),
        },
      });
      if (errorCode && name !== 'finalize') {
        // What needs this step cannot run: public steps after it and the
        // personal match. `finalize` still runs to set the overall status.
        // PERF-3: when an older public analysis of the book exists, it is shown
        // (marked stale) and the personal match can still run on it.
        const stale = PUBLIC_STEPS.includes(name)
          ? await this.staleFallback(tx, analysisId)
          : false;
        const blocked = PUBLIC_STEPS.includes(name)
          ? STEP_ORDER.slice(STEP_ORDER.indexOf(name) + 1, -1).filter(
              (s) => !(stale && s === 'personalMatch'),
            )
          : [];
        if (PUBLIC_STEPS.includes(name)) await this.releaseBuild(tx, analysisId);
        if (blocked.length > 0) {
          await tx.analysisStep.updateMany({
            where: { analysisId, step: { in: blocked }, status: 'pending' },
            data: { status: 'skipped' },
          });
        }
      }
      if (errorCode && name === 'finalize') {
        // Never leave an analysis running forever.
        await tx.analysis.update({
          where: { id: analysisId },
          data: { status: 'failed', finishedAt: new Date() },
        });
      }
    });
    this.logger.log(
      JSON.stringify({
        event: 'analysis_step',
        analysisId,
        step: name,
        status: errorCode ? 'failed' : 'done',
        errorCode,
        durationMs,
      }),
    );
  }

  private errorCodeOf(error: unknown, step: StepName, analysisId: string): ErrorCode {
    if (error instanceof StepError) return error.code;
    if (error instanceof TraitExtractionError || error instanceof SummaryError) {
      this.logger.warn(`${step} for ${analysisId}: ${error.message}`);
      return 'INVALID_MODEL_OUTPUT';
    }
    if (error instanceof LlmError) {
      this.logger.warn(`${step} for ${analysisId}: language model ${error.kind}: ${error.message}`);
      if (error.kind === 'quota') return 'LLM_QUOTA_EXHAUSTED';
      if (error.kind === 'blocked') return 'INVALID_MODEL_OUTPUT';
      return 'INTERNAL_ERROR';
    }
    this.logger.error(
      `${step} for ${analysisId} failed: ${(error as Error).stack ?? String(error)}`,
    );
    return 'INTERNAL_ERROR';
  }

  private async context(analysisId: string): Promise<Context> {
    const analysis = await this.prisma.analysis.findUniqueOrThrow({
      where: { id: analysisId },
      include: { steps: true },
    });
    const [edition] = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; title: string; description: string | null; authors: string[] | null }>
    >(
      `SELECT e.id, e.title, e.description,
         COALESCE(
           (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
              JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND ea.role IS NULL),
           (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
              JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id)) AS authors
       FROM editions e WHERE e.id = $1::uuid`,
      analysis.editionId,
    );
    if (!edition) throw new Error(`Edition ${analysis.editionId} is missing`);
    const outputs: Outputs = {};
    for (const s of analysis.steps) if (s.status === 'done') outputs[s.step as StepName] = s.output;
    return {
      analysisId,
      userId: analysis.userId,
      editionId: analysis.editionId,
      tasteProfileVersionId: analysis.tasteProfileVersionId,
      publicAnalysisId: analysis.publicAnalysisId,
      refresh: analysis.refresh,
      createdAt: analysis.createdAt,
      edition: { ...edition, authors: edition.authors ?? [] },
      outputs,
    };
  }

  private readonly handlers: Record<StepName, (ctx: Context) => Promise<unknown>> = {
    resolve: (ctx) => this.resolve(ctx),
    fetchReviews: (ctx) => this.fetchReviews(ctx),
    selectReviews: (ctx) => this.selectReviews(ctx),
    extractTraits: (ctx) => this.extractTraits(ctx),
    publicSummary: (ctx) => this.publicSummary(ctx),
    evidenceConfidence: (ctx) => this.evidenceConfidence(ctx),
    personalMatch: (ctx) => this.personalMatch(ctx),
    finalize: (ctx) => this.finalize(ctx),
  };

  /**
   * Reuses a fresh public analysis of this edition (spec 10, PERF-1), so no
   * source or model is asked again. Otherwise one analysis claims the build
   * and every other analysis of the book waits for it and reuses the result
   * (PERF-2, D-025). A refresh only reuses a build made after it was asked.
   */
  private async resolve(ctx: Context): Promise<ResolveOutput> {
    const started = Date.now();
    const reusable = () =>
      this.prisma.publicAnalysis.findFirst({
        where: {
          editionId: ctx.editionId,
          ...(ctx.refresh
            ? { generatedAt: { gte: ctx.createdAt } }
            : { expiresAt: { gt: new Date() } }),
        },
        orderBy: { reviewsVersion: 'desc' },
        select: { id: true },
      });
    for (;;) {
      const fresh = await reusable();
      if (fresh) return this.reuse(ctx, fresh.id, Date.now() - started);
      if (await this.claimBuild(ctx)) {
        // The build may have finished between the check and the claim.
        const justBuilt = await reusable();
        if (!justBuilt) return { reusedPublicAnalysisId: null, waitedMs: Date.now() - started };
        await this.prisma.publicAnalysisBuild.deleteMany({ where: { analysisId: ctx.analysisId } });
        return this.reuse(ctx, justBuilt.id, Date.now() - started);
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.PUBLIC_BUILD_WAIT_POLL_MS));
    }
  }

  /**
   * Claims the build of this edition's public analysis. A claim held by this
   * analysis (a resumed run) or older than PUBLIC_BUILD_CLAIM_TTL_SECONDS (an
   * abandoned one) is taken over.
   */
  private async claimBuild(ctx: Context): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ analysis_id: string }>>(
      `INSERT INTO public_analysis_builds (edition_id, analysis_id, claimed_at)
       VALUES ($1::uuid, $2::uuid, now())
       ON CONFLICT (edition_id) DO UPDATE SET analysis_id = EXCLUDED.analysis_id, claimed_at = now()
         WHERE public_analysis_builds.analysis_id = EXCLUDED.analysis_id
            OR public_analysis_builds.claimed_at < now() - make_interval(secs => $3)
       RETURNING analysis_id`,
      ctx.editionId,
      ctx.analysisId,
      this.config.PUBLIC_BUILD_CLAIM_TTL_SECONDS,
    );
    return rows.length === 1;
  }

  private async releaseBuild(tx: Prisma.TransactionClient, analysisId: string): Promise<void> {
    await tx.publicAnalysisBuild.deleteMany({ where: { analysisId } });
  }

  /**
   * PERF-3: a public step failed. When the book has an older public analysis
   * and this analysis has none, it is shown instead, marked stale with its date.
   */
  private async staleFallback(tx: Prisma.TransactionClient, analysisId: string): Promise<boolean> {
    const analysis = await tx.analysis.findUniqueOrThrow({
      where: { id: analysisId },
      select: { editionId: true, publicAnalysisId: true },
    });
    if (analysis.publicAnalysisId) return true;
    const older = await tx.publicAnalysis.findFirst({
      where: { editionId: analysis.editionId },
      orderBy: { reviewsVersion: 'desc' },
      select: { id: true },
    });
    if (!older) return false;
    await tx.analysis.update({ where: { id: analysisId }, data: { publicAnalysisId: older.id } });
    return true;
  }

  private async reuse(
    ctx: Context,
    publicAnalysisId: string,
    waitedMs: number,
  ): Promise<ResolveOutput> {
    const fresh = { id: publicAnalysisId };
    await this.prisma.$transaction([
      this.prisma.analysis.update({
        where: { id: ctx.analysisId },
        data: { publicAnalysisId: fresh.id },
      }),
      this.prisma.analysisStep.updateMany({
        where: {
          analysisId: ctx.analysisId,
          step: { in: PUBLIC_STEPS.slice(1) },
          status: 'pending',
        },
        data: { status: 'done', output: { reused: true }, finishedAt: new Date(), durationMs: 0 },
      }),
    ]);
    return { reusedPublicAnalysisId: fresh.id, waitedMs };
  }

  /**
   * The dataset reviews (stored text) and the live rating sources (BE-5).
   * Every source failing is SOURCES_UNAVAILABLE, never "no reviews" (RES-4);
   * the outcomes are kept so the screen can say which failed.
   */
  private async fetchReviews(ctx: Context): Promise<FetchOutput> {
    const sources: StoredSource[] = [];
    const dataset = await this.datasetSource(ctx.editionId);
    if (dataset) sources.push(dataset);
    // PERF-1: a source's still-valid earlier answer is reused; a refresh asks again.
    const live =
      (await this.ratingSources.lookupEdition(ctx.editionId, { useCache: !ctx.refresh })) ?? [];
    await this.recorder.sourceCalls(ctx.analysisId, ctx.editionId, live);
    for (const r of live) {
      sources.push({
        key: r.key,
        name: r.name,
        outcome: r.outcome,
        providesText: r.providesText,
        storageAllowed: r.storageAllowed,
        // D-020: numbers from a source that may not be stored are not kept.
        ratingAverage: r.storageAllowed ? r.ratingAverage : null,
        ratingCount: r.storageAllowed ? r.ratingCount : null,
        ratingScope: r.storageAllowed ? r.ratingScope : null,
        detail: r.detail,
        fetchedAt: r.fetchedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      });
    }
    const output: FetchOutput = { sources };
    const failed = (s: StoredSource) => s.outcome === 'failed' || s.outcome === 'rate_limited';
    if (sources.length === 0 || sources.every(failed))
      throw new StepError('SOURCES_UNAVAILABLE', output);
    return output;
  }

  /**
   * The dataset as a source: its stored reviews with text and Goodreads' own
   * rating summary (D-014). A read error makes this source `failed`, like any
   * other source, never "no reviews".
   */
  private async datasetSource(editionId: string): Promise<StoredSource | null> {
    const base = {
      key: DATASET_SOURCE_KEY,
      providesText: true,
      storageAllowed: true,
      expiresAt: null,
    };
    try {
      const [row] = await this.prisma.$queryRawUnsafe<
        Array<{
          name: string;
          has_text: boolean;
          rating_average: string | null;
          rating_count: number | null;
          fetched_at: Date | null;
        }>
      >(
        `SELECT s.name,
           -- Only whether usable text exists; counting a popular book's reviews is slow.
           EXISTS (SELECT 1 FROM reviews r WHERE r.edition_id = $1::uuid AND r.source_id = s.id
              AND r.text IS NOT NULL AND r.text_length >= $3) AS has_text,
           f.rating_average::text AS rating_average, f.rating_count, f.fetched_at
         FROM review_sources s
         LEFT JOIN review_fetches f ON f.source_id = s.id AND f.edition_id = $1::uuid AND f.reviews_version = 1
         WHERE s.key = $2 AND s.enabled`,
        editionId,
        DATASET_SOURCE_KEY,
        this.config.EVIDENCE_MIN_REVIEW_CHARS,
      );
      if (!row) return null;
      const count = row.rating_count ?? 0;
      return {
        ...base,
        name: row.name,
        outcome: row.has_text || count > 0 ? 'ok' : 'empty',
        ratingAverage: count > 0 && row.rating_average ? Number(row.rating_average) : null,
        ratingCount: count > 0 ? count : null,
        ratingScope: count > 0 ? 'edition' : null,
        detail: null,
        fetchedAt: row.fetched_at?.toISOString() ?? null,
      };
    } catch (error) {
      this.logger.warn(
        `Dataset reviews could not be read for ${editionId}: ${(error as Error).message}`,
      );
      return {
        ...base,
        name: 'Goodreads (UCSD Book Graph dataset)',
        outcome: 'failed',
        ratingAverage: null,
        ratingCount: null,
        ratingScope: null,
        detail: 'internal',
        fetchedAt: new Date().toISOString(),
      };
    }
  }

  /** The bounded evidence set (spec 8), and the evidence state computed from it in code. */
  private async selectReviews(ctx: Context): Promise<SelectOutput> {
    const fetched = ctx.outputs.fetchReviews as FetchOutput;
    const candidates = await this.evidence.candidateReviews(ctx.editionId, {
      limit: this.config.EVIDENCE_CANDIDATE_LIMIT,
      minChars: this.config.EVIDENCE_MIN_REVIEW_CHARS,
    });
    const { selected, dropped } = selectEvidence(
      candidates,
      selectionOptions(this.config, this.config.EVIDENCE_MAX_REVIEWS),
    );
    const inputs = {
      sources: fetched.sources.map((s) => ({
        name: s.name,
        outcome: s.outcome,
        ratingCount: s.ratingCount,
      })),
      textReviews: selected.length,
      textSources: new Set(selected.map((r) => r.sourceKey)).size,
      positive: selected.filter((r) => r.sentiment === 'positive').length,
      negative: selected.filter((r) => r.sentiment === 'negative').length,
    };
    return {
      selected: selected.map((r) => ({
        position: r.position,
        reviewId: r.id,
        sourceKey: r.sourceKey,
        rating: r.rating,
      })),
      dropped,
      evidenceState: evidenceStateOf(inputs, this.thresholds()),
      inputs,
    };
  }

  /**
   * The output of an earlier build of this book's public analysis for the
   * same step, when it read exactly the same evidence with the same model and
   * prompt: asking the model again would cost a call for the same input (D-025).
   */
  private async earlierOutput<T extends { model: string | null; promptVersion: string | null }>(
    ctx: Context,
    step: 'extractTraits' | 'publicSummary',
    model: string,
    promptVersion: string,
  ): Promise<(T & { reusedFrom: string }) | null> {
    const selection = ctx.outputs.selectReviews as SelectOutput;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ analysis_id: string; selected: unknown; output: T }>
    >(
      `SELECT a.id AS analysis_id, sel.output -> 'selected' AS selected, st.output
         FROM analyses a
         JOIN analysis_steps sel ON sel.analysis_id = a.id AND sel.step = 'selectReviews' AND sel.status = 'done'
         JOIN analysis_steps st ON st.analysis_id = a.id AND st.step = $2::step_name AND st.status = 'done'
        WHERE a.edition_id = $1::uuid AND a.id <> $3::uuid
          AND NOT (sel.output ? 'reused') AND NOT (st.output ? 'reused')
          AND st.output ->> 'model' = $4 AND st.output ->> 'promptVersion' = $5
        ORDER BY st.finished_at DESC LIMIT 5`,
      ctx.editionId,
      step,
      ctx.analysisId,
      model,
      promptVersion,
    );
    const same = JSON.stringify(selection.selected);
    const match = rows.find((r) => JSON.stringify(r.selected) === same);
    if (!match) return null;
    const { reusedFrom: _earlier, ...output } = match.output as T & { reusedFrom?: string };
    return { ...(output as T), reusedFrom: match.analysis_id };
  }

  private async extractTraits(ctx: Context): Promise<TraitsOutput> {
    const earlier = await this.earlierOutput<TraitsOutput>(
      ctx,
      'extractTraits',
      this.config.GEMINI_TRAIT_MODEL,
      TRAIT_PROMPT_VERSION,
    );
    if (earlier) return earlier;
    const reviews = await this.reviewTexts(ctx.outputs.selectReviews as SelectOutput);
    if (reviews.length === 0 && !ctx.edition.description) {
      return { traits: null, model: null, promptVersion: null };
    }
    const result = await this.measured(ctx, 'extractTraits', this.config.GEMINI_TRAIT_MODEL, () =>
      extractTraits(this.llm, this.config.GEMINI_TRAIT_MODEL, {
        title: ctx.edition.title,
        authors: ctx.edition.authors,
        description: ctx.edition.description,
        reviews,
      }),
    );
    return { traits: result.traits, model: result.model, promptVersion: result.promptVersion };
  }

  /** No usable reviews: no written verdict and no model call (RES-3). */
  private async publicSummary(ctx: Context): Promise<SummaryOutput> {
    const selection = ctx.outputs.selectReviews as SelectOutput;
    if (selection.evidenceState === 'insufficient' || selection.selected.length === 0) {
      return { summary: null, model: null, promptVersion: null };
    }
    const earlier = await this.earlierOutput<SummaryOutput>(
      ctx,
      'publicSummary',
      this.config.GEMINI_SUMMARY_MODEL,
      SUMMARY_PROMPT_VERSION,
    );
    if (earlier) return earlier;
    const reviews = await this.reviewTexts(selection);
    const result = await this.measured(ctx, 'publicSummary', this.config.GEMINI_SUMMARY_MODEL, () =>
      generateSummary(this.llm, this.config.GEMINI_SUMMARY_MODEL, {
        title: ctx.edition.title,
        authors: ctx.edition.authors,
        description: ctx.edition.description,
        reviews,
      }),
    );
    return { summary: result.summary, model: result.model, promptVersion: result.promptVersion };
  }

  /**
   * Computes the public confidence in code and saves the shared public
   * analysis in one transaction: evidence items, cited claims, traits and the
   * live sources' outcomes. Foreign keys make a citation to missing evidence
   * impossible (RES-5).
   */
  private async evidenceConfidence(ctx: Context): Promise<ConfidenceOutput> {
    const fetched = ctx.outputs.fetchReviews as FetchOutput;
    const selection = ctx.outputs.selectReviews as SelectOutput;
    const traits = (ctx.outputs.extractTraits as TraitsOutput).traits;
    const written = ctx.outputs.publicSummary as SummaryOutput;
    const { level, reasons } = publicConfidence(selection.inputs, this.thresholds());

    const now = new Date();
    const expiries = fetched.sources
      .filter((s) => s.storageAllowed && s.outcome !== 'ok' && s.expiresAt)
      .map((s) => new Date(s.expiresAt!).getTime());
    // A public analysis built while a source failed is rebuilt once that failure expires (spec 10).
    const expiresAt = new Date(
      Math.min(now.getTime() + this.config.CACHE_REVIEWS_TTL_DAYS * 24 * HOUR, ...expiries),
    );

    const publicAnalysisId = await this.prisma.$transaction(
      async (tx) => {
        // One version number at a time per edition.
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          `public:${ctx.editionId}`,
        );
        const latest = await tx.publicAnalysis.aggregate({
          where: { editionId: ctx.editionId },
          _max: { reviewsVersion: true },
        });
        const reviewsVersion = (latest._max.reviewsVersion ?? 0) + 1;
        const pa = await tx.publicAnalysis.create({
          data: {
            editionId: ctx.editionId,
            reviewsVersion,
            evidenceState: selection.evidenceState,
            confidence: level,
            confidenceReasons: reasons,
            // The counts the confidence came from, and every source asked with its
            // outcome (no numbers from a source that may not be stored, D-020).
            confidenceInputs: {
              ...selection.inputs,
              sourceDetails: fetched.sources,
            } as unknown as Prisma.InputJsonValue,
            summary: written.summary?.summary ?? null,
            llmModel: written.model,
            promptVersion: written.promptVersion,
            expiresAt,
          },
        });

        // Evidence numbers: 1..N are the selected reviews; 0 is the description,
        // stored after them because positions start at 1.
        const itemIds = new Map<number, string>();
        for (const r of selection.selected) {
          const item = await tx.evidenceItem.create({
            data: {
              publicAnalysisId: pa.id,
              position: r.position,
              kind: 'review',
              reviewId: r.reviewId,
            },
          });
          itemIds.set(r.position, item.id);
        }
        if (ctx.edition.description) {
          const item = await tx.evidenceItem.create({
            data: {
              publicAnalysisId: pa.id,
              position: selection.selected.length + 1,
              kind: 'description',
            },
          });
          itemIds.set(DESCRIPTION_EVIDENCE, item.id);
        }
        const cite = (numbers: number[]) =>
          numbers.map((n) => {
            const id = itemIds.get(n);
            if (!id) throw new StepError('INVALID_MODEL_OUTPUT');
            return id;
          });

        const claims = [
          ...(written.summary?.praises ?? []).map((p, i) => ({
            ...p,
            kind: 'praise' as const,
            rank: i + 1,
          })),
          ...(written.summary?.complaints ?? []).map((p, i) => ({
            ...p,
            kind: 'complaint' as const,
            rank: i + 1,
          })),
        ];
        for (const c of claims) {
          const claim = await tx.analysisClaim.create({
            data: { publicAnalysisId: pa.id, kind: c.kind, text: c.text, rank: c.rank },
          });
          await tx.claimEvidence.createMany({
            data: cite(c.evidence).map((evidenceItemId) => ({
              claimId: claim.id,
              publicAnalysisId: pa.id,
              evidenceItemId,
            })),
          });
        }

        for (const t of traitRows(traits)) {
          const trait = await tx.bookTrait.create({
            data: { publicAnalysisId: pa.id, trait: t.trait, value: t.value },
          });
          await tx.traitEvidence.createMany({
            data: cite(t.evidence).map((evidenceItemId) => ({
              bookTraitId: trait.id,
              publicAnalysisId: pa.id,
              evidenceItemId,
            })),
          });
        }

        // Live sources' outcomes for this reviews version (D-020). The dataset
        // has its own permanent row from the import (D-014).
        const live = fetched.sources.filter((s) => s.key !== DATASET_SOURCE_KEY);
        const ids = await tx.reviewSource.findMany({
          where: { key: { in: live.map((s) => s.key) } },
          select: { id: true, key: true },
        });
        const idOf = new Map(ids.map((r) => [r.key, r.id]));
        for (const s of live) {
          const sourceId = idOf.get(s.key);
          if (!sourceId) continue;
          await tx.reviewFetch.create({
            data: {
              editionId: ctx.editionId,
              sourceId,
              reviewsVersion,
              outcome: s.outcome,
              errorCode: s.outcome === 'failed' || s.outcome === 'rate_limited' ? s.detail : null,
              ratingAverage: s.ratingAverage,
              ratingCount: s.ratingCount,
              workLevelOnly: s.ratingScope === 'work',
              fetchedAt: s.fetchedAt ? new Date(s.fetchedAt) : now,
              expiresAt: s.expiresAt ? new Date(s.expiresAt) : now,
            },
          });
        }
        await tx.analysis.update({
          where: { id: ctx.analysisId },
          data: { publicAnalysisId: pa.id },
        });
        // Waiting analyses of this book can now reuse it (PERF-2).
        await this.releaseBuild(tx, ctx.analysisId);
        return pa.id;
      },
      { timeout: 30_000 },
    );
    return { publicAnalysisId, level, reasons };
  }

  /**
   * MODEL-4: below the hard floor there is no score. Above it the taste model
   * scores (BE-13, D-024), and the result is stored with its model version,
   * profile version and time (MODEL-3) and the model's explanations. Without a
   * loaded model the step fails with MODEL_UNAVAILABLE (D-021); either way the
   * public reception is unaffected (RES-7).
   */
  private async personalMatch(ctx: Context): Promise<PersonalOutput> {
    const ratedCount = ctx.tasteProfileVersionId
      ? await this.prisma.profileRating.count({
          where: { tasteProfileVersionId: ctx.tasteProfileVersionId },
        })
      : 0;
    const base = {
      analysisId: ctx.analysisId,
      userId: ctx.userId,
      editionId: ctx.editionId,
      tasteProfileVersionId: ctx.tasteProfileVersionId,
      publicAnalysisId: ctx.publicAnalysisId,
    };
    if (!ctx.tasteProfileVersionId || ratedCount < this.config.TASTE_HARD_FLOOR) {
      const outcome =
        !ctx.tasteProfileVersionId || ratedCount === 0 ? 'needs_taste_data' : 'below_floor';
      await this.prisma.personalAnalysis.create({ data: { ...base, outcome } });
      return { outcome };
    }
    const scored = await this.scorer.score({
      userId: ctx.userId,
      editionId: ctx.editionId,
      tasteProfileVersionId: ctx.tasteProfileVersionId,
      publicAnalysisId: ctx.publicAnalysisId,
    });
    if (!scored) throw new StepError('MODEL_UNAVAILABLE');
    await this.prisma.personalAnalysis.create({
      data: {
        ...base,
        outcome: 'scored',
        score: new Prisma.Decimal(scored.score.toFixed(2)),
        modelVersionId: scored.modelVersionId,
        confidence: scored.confidence.level,
        confidenceReasons: scored.confidence.reasons,
        similarBooks: {
          create: scored.similarBooks.map((b, i) => ({
            rank: i + 1,
            editionId: b.editionId,
            yourRating: b.yourRating,
            similarity: new Prisma.Decimal(b.similarity.toFixed(5)),
          })),
        },
        traitFits: { create: scored.traitFits },
      },
    });
    this.logger.log(
      `personal match ${ctx.analysisId}: ${scored.modelId} ${scored.score} (${scored.confidence.level})`,
    );
    return { outcome: 'scored' };
  }

  /** The overall status, from the step results (CONTRACT 4.4 status rules). */
  private async finalize(ctx: Context): Promise<{ status: string }> {
    const steps = await this.prisma.analysisStep.findMany({
      where: { analysisId: ctx.analysisId },
    });
    const status = (name: StepName) => steps.find((s) => s.step === name)?.status;
    let evidenceState: string | null = null;
    if (ctx.publicAnalysisId) {
      const pa = await this.prisma.publicAnalysis.findUnique({
        where: { id: ctx.publicAnalysisId },
        select: { evidenceState: true },
      });
      evidenceState = pa?.evidenceState ?? null;
    }
    // PERF-3: with an older reception shown, the analysis is partial, not failed.
    const result = PUBLIC_STEPS.some((s) => status(s) === 'failed')
      ? ctx.publicAnalysisId
        ? 'partial'
        : 'failed'
      : evidenceState === 'limited' ||
          evidenceState === 'insufficient' ||
          status('personalMatch') === 'failed'
        ? 'partial'
        : 'complete';
    await this.prisma.$transaction(async (tx) => {
      await tx.analysis.update({
        where: { id: ctx.analysisId },
        data: { status: result, finishedAt: new Date() },
      });
      await this.releaseBuild(tx, ctx.analysisId);
    });
    return { status: result };
  }

  /** The selected reviews' text, cut exactly as at selection (same order and numbers). */
  private async reviewTexts(selection: SelectOutput): Promise<SelectedReview[]> {
    if (selection.selected.length === 0) return [];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; text: string }>>(
      `SELECT id, text FROM reviews WHERE id = ANY($1::uuid[])`,
      selection.selected.map((r) => r.reviewId),
    );
    const textOf = new Map(rows.map((r) => [r.id, r.text]));
    return selection.selected.flatMap((r) => {
      const text = textOf.get(r.reviewId);
      if (text === undefined) return [];
      const cut = truncate(text.trim(), this.config.EVIDENCE_MAX_REVIEW_CHARS);
      return [
        {
          position: r.position,
          id: r.reviewId,
          sourceKey: r.sourceKey,
          rating: r.rating,
          sentiment: sentimentOf(r.rating),
          text: cut.text,
          truncated: cut.truncated,
        },
      ];
    });
  }

  private thresholds() {
    return {
      sufficientReviews: this.config.EVIDENCE_SUFFICIENT_REVIEWS,
      highReviews: this.config.PUBLIC_CONFIDENCE_HIGH_REVIEWS,
    };
  }

  /**
   * Runs a model step and records every request it made (H4, D-026): each
   * attempt with its tokens, an invalid answer as `invalid_output`, and a
   * request the client gave up on (quota, timeout, ...) with no tokens.
   */
  private async measured<T extends { usage: LlmUsage[] }>(
    ctx: Context,
    step: 'extractTraits' | 'publicSummary',
    model: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const record = (calls: ReturnType<typeof attemptsAsCalls>) =>
      this.recorder.llmCalls(ctx.analysisId, ctx.editionId, step, calls);
    try {
      const result = await call();
      await record(attemptsAsCalls(result.usage, 'ok'));
      this.logUsage(ctx, step, result.usage);
      return result;
    } catch (error) {
      if (error instanceof TraitExtractionError || error instanceof SummaryError) {
        await record(attemptsAsCalls(error.usage, 'invalid_output'));
      } else if (error instanceof LlmError) {
        const none = { model, inputTokens: 0, outputTokens: 0, latencyMs: 0, waitedMs: 0 };
        await record([{ usage: none, outcome: error.kind }]);
      }
      throw error;
    }
  }

  /** Token use per step in the log, next to the stored calls (spec 12). */
  private logUsage(ctx: Context, step: StepName, usage: LlmUsage[]) {
    this.logger.log(
      JSON.stringify({
        event: 'analysis_llm',
        analysisId: ctx.analysisId,
        step,
        calls: usage.length,
        model: usage[0]?.model,
        inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
        outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
        latencyMs: usage.reduce((s, u) => s + u.latencyMs, 0),
      }),
    );
  }
}

/** Trait values that are known, one row per value (unknown means no row). */
function traitRows(traits: ExtractedTraits | null): Array<{
  trait: 'pace' | 'tone' | 'contentIntensity' | 'themes';
  value: string;
  evidence: number[];
}> {
  if (!traits) return [];
  const rows: Array<{
    trait: 'pace' | 'tone' | 'contentIntensity' | 'themes';
    value: string;
    evidence: number[];
  }> = [];
  for (const key of ['pace', 'tone', 'contentIntensity'] as const) {
    if (traits[key].value !== 'unknown') rows.push({ trait: key, ...traits[key] });
  }
  for (const theme of traits.themes) rows.push({ trait: 'themes', ...theme });
  return rows;
}
