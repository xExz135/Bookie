import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import type { ErrorCode } from '../contract/error-codes';
import { PrismaService } from '../database/prisma.service';
import { plainText } from '../representation/book-text';
import { truncate } from '../representation/evidence-selection';
import type { Analysis, AnalysisSummary } from './analysis.schemas';
import {
  type FetchOutput,
  PUBLIC_STEPS,
  STEP_ORDER,
  type SelectOutput,
  type StepName,
  type StoredSource,
} from './analysis.types';
import { PERSONAL_SCORER, type PersonalScorer } from './personal-scorer';

/** CONTRACT 4.4: excerpts are at most 1,000 characters. */
const MAX_EXCERPT = 1000;
const TRAIT_KEYS = ['pace', 'tone', 'themes', 'contentIntensity'] as const;

type Public = Analysis['publicReception'];
type Personal = Analysis['personalMatch'];
type Source = Public['sources'][number];
type Evidence = Public['evidence'][number];

/**
 * Builds the Analysis object (CONTRACT 4.4) from the database. The server
 * decides every derived field (status of each section, canRetry, isOutdated,
 * pollAfterMs); the browser only displays them (D-019).
 */
@Injectable()
export class AnalysisView {
  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
    @Inject(PERSONAL_SCORER) private readonly scorer: PersonalScorer,
  ) {}

  /** Null when the analysis does not exist or is not this reader's (404, never 403). */
  async get(userId: string, analysisId: string): Promise<Analysis | null> {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, userId },
      include: {
        steps: true,
        tasteProfileVersion: { select: { versionNo: true, _count: { select: { ratings: true } } } },
        personalAnalysis: true,
        feedback: true,
      },
    });
    if (!analysis) return null;

    const steps = new Map(analysis.steps.map((s) => [s.step as StepName, s]));
    const stepStatus = (name: StepName) => steps.get(name)?.status ?? 'pending';
    const output = <T>(name: StepName) => (steps.get(name)?.output ?? null) as T | null;

    const [edition, current, publicReception, canRetryModel] = await Promise.all([
      this.edition(analysis.editionId),
      this.prisma.tasteProfileVersion.findFirst({
        where: { userId },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      }),
      this.publicReception(analysis.publicAnalysisId, stepStatus, output),
      this.scorer.available(),
    ]);

    const running = analysis.status === 'running';
    const failedSteps = analysis.steps.filter((s) => s.status === 'failed');
    const canRetry =
      !running && failedSteps.some((s) => s.errorCode !== 'MODEL_UNAVAILABLE' || canRetryModel);

    const versionNo = analysis.tasteProfileVersion?.versionNo ?? null;
    const currentVersion = current?.versionNo ?? 0;
    const pa = analysis.personalAnalysis;
    const personalStep = stepStatus('personalMatch');
    const personalStatus: Personal['status'] =
      personalStep === 'done'
        ? pa?.outcome === 'scored'
          ? 'done'
          : (pa?.outcome ?? 'needs_taste_data')
        : personalStep === 'pending'
          ? 'running'
          : personalStep;
    const scored = personalStatus === 'done' && pa?.score != null;
    const personalMatch: Personal = {
      status: personalStatus,
      score: scored ? Math.round(Number(pa!.score) * 10) / 10 : null,
      scale: { min: 1, max: 5 },
      // Model details and explanations arrive with the taste models (BE-13).
      modelId: null,
      modelVersion: null,
      isFallback: false,
      evidenceConfidence: null,
      tasteProfileVersion: versionNo,
      currentTasteProfileVersion: currentVersion,
      isOutdated: currentVersion > (versionNo ?? 0),
      ratedCount: analysis.tasteProfileVersion?._count.ratings ?? 0,
      hardFloor: this.config.TASTE_HARD_FLOOR,
      minForConfidence: this.config.TASTE_MIN_RATED_FOR_CONFIDENCE,
      generatedAt: pa?.generatedAt.toISOString() ?? null,
      similarRatedBooks: [],
      traits: [],
      errorCode:
        personalStep === 'failed'
          ? ((steps.get('personalMatch')?.errorCode ?? 'INTERNAL_ERROR') as ErrorCode)
          : null,
    };

    const feedbackOf = (target: 'public' | 'personal') =>
      analysis.feedback.find((f) => f.target === target)?.value ?? null;
    return {
      id: analysis.id,
      status: analysis.status,
      pollAfterMs: running ? this.config.ANALYSIS_POLL_AFTER_MS : null,
      createdAt: analysis.createdAt.toISOString(),
      finishedAt: analysis.finishedAt?.toISOString() ?? null,
      recalculatedFromId: analysis.recalculatedFromId,
      canRetry,
      edition,
      steps: STEP_ORDER.map((name) => ({
        name,
        status: stepStatus(name),
        errorCode:
          stepStatus(name) === 'failed'
            ? ((steps.get(name)?.errorCode ?? 'INTERNAL_ERROR') as ErrorCode)
            : null,
      })),
      publicReception,
      personalMatch,
      feedback: {
        public: publicReception.status === 'done' ? feedbackOf('public') : null,
        personal: personalMatch.status === 'done' ? feedbackOf('personal') : null,
      },
    };
  }

  /** A history row: the same fields, without evidence, claims or traits. */
  toSummary(a: Analysis): AnalysisSummary {
    const { isbn13: _i, pageCount: _p, description: _d, ...candidate } = a.edition;
    const pr = a.publicReception;
    const pm = a.personalMatch;
    return {
      id: a.id,
      status: a.status,
      createdAt: a.createdAt,
      finishedAt: a.finishedAt,
      edition: candidate,
      publicReception: {
        status: pr.status,
        evidenceState: pr.evidenceState,
        summary: pr.summary,
        evidenceConfidence: pr.evidenceConfidence,
      },
      personalMatch: {
        status: pm.status,
        score: pm.score,
        scale: pm.scale,
        modelId: pm.modelId,
        isFallback: pm.isFallback,
        evidenceConfidence: pm.evidenceConfidence,
        tasteProfileVersion: pm.tasteProfileVersion,
        currentTasteProfileVersion: pm.currentTasteProfileVersion,
        isOutdated: pm.isOutdated,
      },
      feedback: a.feedback,
    };
  }

  private async edition(editionId: string): Promise<Analysis['edition']> {
    const [row] = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        title: string;
        subtitle: string | null;
        authors: string[] | null;
        publication_year: number | null;
        language: string | null;
        publisher: string | null;
        format: string | null;
        cover_url: string | null;
        isbn_13: string | null;
        page_count: number | null;
        description: string | null;
      }>
    >(
      `SELECT e.id, e.title, e.subtitle, e.publication_year, e.language, e.publisher, e.format,
         e.cover_url, e.isbn_13, e.page_count, e.description,
         COALESCE(
           (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
              JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND ea.role IS NULL),
           (SELECT array_agg(a.name ORDER BY ea.position) FROM edition_authors ea
              JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id)) AS authors
       FROM editions e WHERE e.id = $1::uuid`,
      editionId,
    );
    if (!row) throw new Error(`Edition ${editionId} is missing`);
    return {
      editionId: row.id,
      title: row.title,
      subtitle: row.subtitle,
      author: row.authors?.length ? row.authors.join(', ') : null,
      year: row.publication_year,
      language: row.language,
      publisher: row.publisher,
      format: row.format,
      coverUrl: row.cover_url,
      isbn13: row.isbn_13,
      pageCount: row.page_count && row.page_count > 0 ? row.page_count : null,
      description: row.description,
    };
  }

  private async publicReception(
    publicAnalysisId: string | null,
    stepStatus: (name: StepName) => string,
    output: <T>(name: StepName) => T | null,
  ): Promise<Public> {
    const statuses = PUBLIC_STEPS.map(stepStatus);
    const failed = statuses.includes('failed');
    const done =
      !failed && publicAnalysisId !== null && stepStatus('evidenceConfidence') === 'done';
    const status: Public['status'] = failed
      ? 'failed'
      : done
        ? 'done'
        : statuses.every((s) => s === 'pending')
          ? 'pending'
          : 'running';

    if (done) return this.savedReception(publicAnalysisId!);

    // Not saved yet: show what the steps have found so far, so failures are disclosed (spec 11).
    const fetched = output<FetchOutput>('fetchReviews');
    const selection = output<SelectOutput>('selectReviews');
    const sourcesFailed = stepStatus('fetchReviews') === 'failed';
    return {
      status,
      evidenceState: sourcesFailed ? 'unavailable' : (selection?.evidenceState ?? null),
      summary: null,
      praises: [],
      complaints: [],
      traits: [],
      sources: (fetched?.sources ?? []).map((s) => this.sourceView(s, 0)),
      evidence: [],
      evidenceConfidence: null,
      generatedAt: null,
    };
  }

  private sourceView(s: StoredSource, reviewsUsed: number): Source {
    return {
      key: s.key,
      name: s.name,
      outcome: s.outcome,
      providesText: s.providesText,
      ratingAverage: s.ratingAverage,
      ratingCount: s.ratingCount,
      ratingScope: s.ratingScope,
      reviewsUsed,
      fetchedAt: s.fetchedAt,
    };
  }

  private async savedReception(publicAnalysisId: string): Promise<Public> {
    const pa = await this.prisma.publicAnalysis.findUniqueOrThrow({
      where: { id: publicAnalysisId },
      include: {
        claims: { include: { evidence: true }, orderBy: [{ kind: 'asc' }, { rank: 'asc' }] },
        traits: { include: { evidence: true }, orderBy: { value: 'asc' } },
        edition: { select: { description: true } },
      },
    });

    // Every source asked when this public analysis was built, with its outcome.
    const used = await this.prisma.$queryRawUnsafe<Array<{ key: string; n: number }>>(
      `SELECT s.key, count(*)::int AS n FROM evidence_items i
         JOIN reviews r ON r.id = i.review_id JOIN review_sources s ON s.id = r.source_id
        WHERE i.public_analysis_id = $1::uuid AND i.kind = 'review' GROUP BY s.key`,
      publicAnalysisId,
    );
    const usedBy = new Map(used.map((u) => [u.key, u.n]));
    const asked = (pa.confidenceInputs as { sourceDetails?: StoredSource[] }).sourceDetails ?? [];
    const sources = asked.map((s) => this.sourceView(s, usedBy.get(s.key) ?? 0));

    // Only cited evidence is sent, so every cited id resolves within the response (RES-5).
    const citedIds = new Set<string>([
      ...pa.claims.flatMap((c) => c.evidence.map((e) => e.evidenceItemId)),
      ...pa.traits.flatMap((t) => t.evidence.map((e) => e.evidenceItemId)),
    ]);
    const items = await this.prisma.evidenceItem.findMany({
      where: { publicAnalysisId, id: { in: [...citedIds] } },
      include: { review: { include: { source: true } }, source: true },
      orderBy: { position: 'asc' },
    });
    const excerptChars = Math.min(MAX_EXCERPT, this.config.EVIDENCE_MAX_REVIEW_CHARS);
    const evidence: Evidence[] = items.map((item) => {
      if (item.kind === 'description') {
        const text = pa.edition.description ? plainText(pa.edition.description) : null;
        return {
          id: item.id,
          number: item.position,
          kind: 'description',
          source: null,
          rating: null,
          excerpt: text ? truncate(text, excerptChars).text : null,
          displayAllowed: true,
          reviewCount: null,
          postedAt: null,
        };
      }
      if (item.kind === 'source_aggregate') {
        return {
          id: item.id,
          number: item.position,
          kind: 'source_aggregate',
          source: item.source?.key ?? null,
          rating: null,
          excerpt: null,
          displayAllowed: item.source?.displayAllowed ?? false,
          reviewCount: item.reviewCount,
          postedAt: null,
        };
      }
      const review = item.review;
      const displayAllowed = review?.source.displayAllowed ?? false;
      return {
        id: item.id,
        number: item.position,
        kind: 'review',
        source: review?.source.key ?? null,
        rating: review?.rating ?? null,
        excerpt:
          displayAllowed && review?.text ? truncate(review.text.trim(), excerptChars).text : null,
        displayAllowed,
        reviewCount: null,
        postedAt: review?.postedAt?.toISOString() ?? null,
      };
    });

    const claim = (c: (typeof pa.claims)[number]) => ({
      text: c.text,
      evidenceIds: c.evidence.map((e) => e.evidenceItemId),
    });
    return {
      status: 'done',
      evidenceState: pa.evidenceState,
      summary: pa.summary,
      praises: pa.claims.filter((c) => c.kind === 'praise').map(claim),
      complaints: pa.claims.filter((c) => c.kind === 'complaint').map(claim),
      traits: TRAIT_KEYS.map((trait) => {
        const rows = pa.traits.filter((t) => t.trait === trait);
        return {
          trait,
          values: rows.map((t) => t.value),
          evidenceIds: [...new Set(rows.flatMap((t) => t.evidence.map((e) => e.evidenceItemId)))],
        };
      }),
      sources,
      evidence,
      evidenceConfidence: { level: pa.confidence, reasons: pa.confidenceReasons },
      generatedAt: pa.generatedAt.toISOString(),
    };
  }
}
