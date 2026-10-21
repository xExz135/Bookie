import { z } from 'zod';
import { CONTRACT_ENUMS } from '../contract/enums';
import { ERROR_CODES, type ErrorCode } from '../contract/error-codes';
import { candidateSchema } from '../discovery/discovery.schemas';
import { requestSchema, responseSchema } from '../openapi/contract-schemas';

/**
 * CONTRACT 4.4: the Analysis object, the result screen's single source.
 *
 * Published before the endpoints exist (BE-8) so both roles build against the
 * same shape; the fixtures in contract/fixtures/analyses-*.json are checked
 * against these schemas. The refinements below are rules a JSON schema cannot
 * express, so the backend's output and the fixtures are tested against them.
 *
 * The three signals stay separate (D-010): public reception, personal match
 * and each side's evidence confidence. There is no combined field.
 */

const errorCode = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

/** Level plus reasons, computed in code. Never a number (D-010). */
const evidenceConfidenceSchema = z.object({
  level: z.enum(CONTRACT_ENUMS.confidenceLevel),
  /** Plain sentences, for example "38 reviews from 1 source". */
  reasons: z.array(z.string()),
});

/** The analysed edition: everything a candidate has, plus details for the result screen. */
const editionDetailsSchema = candidateSchema.extend({
  isbn13: z.string().nullable(),
  pageCount: z.int().positive().nullable(),
  /** Untrusted text; render as plain text. */
  description: z.string().nullable(),
});

const stepSchema = z.object({
  name: z.enum(CONTRACT_ENUMS.stepName),
  status: z.enum(CONTRACT_ENUMS.stepStatus),
  /** Set only when `status` is `failed`. */
  errorCode: errorCode.nullable(),
});

/**
 * One piece of evidence a claim or trait cites. Only cited items are sent.
 * `number` is stable within the analysis ("Review #12").
 */
const evidenceSchema = z.object({
  id: z.uuid(),
  number: z.int().positive(),
  kind: z.enum(['review', 'description', 'source_aggregate']),
  /** Source key (see `sources`); null for the book description. */
  source: z.string().nullable(),
  /** The reviewer's rating, 1 to 5, when there is one. */
  rating: z.int().min(1).max(5).nullable(),
  /**
   * Untrusted review text, at most 1,000 characters; render as plain text.
   * Null when the source's terms do not allow display, or for aggregates.
   */
  excerpt: z.string().nullable(),
  displayAllowed: z.boolean(),
  /** For `source_aggregate` only: how many reviews the item stands for. */
  reviewCount: z.int().positive().nullable(),
  postedAt: z.iso.datetime().nullable(),
});

const claimSchema = z.object({
  text: z.string(),
  evidenceIds: z.array(z.uuid()).min(1),
});

/** A source asked for this edition, with its outcome and rating summary. */
const sourceSchema = z.object({
  key: z.string(),
  /** Display name. Hardcover's terms require naming it next to its numbers. */
  name: z.string(),
  outcome: z.enum(CONTRACT_ENUMS.sourceOutcome),
  /** False for rating-only sources. */
  providesText: z.boolean(),
  ratingAverage: z.number().min(1).max(5).nullable(),
  ratingCount: z.int().min(0).nullable(),
  /** `work` when the rating covers every edition of the book (Open Library). */
  ratingScope: z.enum(['edition', 'work']).nullable(),
  /** Reviews from this source in the evidence set. */
  reviewsUsed: z.int().min(0),
  /** When this source's data was fetched; older data is labelled with it (PERF-3). */
  fetchedAt: z.iso.datetime().nullable(),
});

/** A trait of the book (D-015 vocabularies). Empty `values` means unknown. */
const bookTraitSchema = z.object({
  trait: z.enum(CONTRACT_ENUMS.traitKey),
  values: z.array(z.string()),
  evidenceIds: z.array(z.uuid()),
});

const publicReceptionSchema = z.object({
  /** `skipped` is not used here. */
  status: z.enum(CONTRACT_ENUMS.stepStatus),
  /**
   * True when this is an older public reception, shown because building a
   * newer one failed (PERF-3): `generatedAt` says when it was made, and the
   * failed step has its `errorCode` and can be retried.
   */
  stale: z.boolean(),
  evidenceState: z.enum(CONTRACT_ENUMS.evidenceState).nullable(),
  /** The written verdict; null until done, and always null when evidence is insufficient or unavailable. */
  summary: z.string().nullable(),
  praises: z.array(claimSchema),
  complaints: z.array(claimSchema),
  traits: z.array(bookTraitSchema),
  sources: z.array(sourceSchema),
  evidence: z.array(evidenceSchema),
  evidenceConfidence: evidenceConfidenceSchema.nullable(),
  generatedAt: z.iso.datetime().nullable(),
});

const similarRatedBookSchema = z.object({
  editionId: z.uuid(),
  title: z.string(),
  author: z.string().nullable(),
  coverUrl: z.string().nullable(),
  yourRating: z.int().min(1).max(5),
});

/**
 * How one trait of the book met the reader's taste. `unknown` means it was
 * not factored in: `yourValues` empty means the reader has no preference on
 * record, `bookValues` empty means the book's trait is unknown.
 */
const traitFitSchema = z.object({
  trait: z.enum(CONTRACT_ENUMS.traitKey),
  fit: z.enum(CONTRACT_ENUMS.traitFit),
  bookValues: z.array(z.string()),
  yourValues: z.array(z.string()),
  evidenceIds: z.array(z.uuid()),
});

const personalMatchSchema = z.object({
  status: z.enum(CONTRACT_ENUMS.personalMatchStatus),
  /** 1 to 5, rounded to one decimal by the server. Null unless `status` is `done`. */
  score: z.number().min(1).max(5).nullable(),
  scale: z.object({ min: z.literal(1), max: z.literal(5) }),
  modelId: z.enum(CONTRACT_ENUMS.modelId).nullable(),
  modelVersion: z.string().nullable(),
  /** True when a cold-start fallback (B0 or B1) produced the score. */
  isFallback: z.boolean(),
  evidenceConfidence: evidenceConfidenceSchema.nullable(),
  /** The profile version used; null when the reader had none. */
  tasteProfileVersion: z.int().positive().nullable(),
  /** The reader's latest version, for the "updated to version N" banner. */
  currentTasteProfileVersion: z.int().min(0),
  /** Computed by the server when read (ONB-4). */
  isOutdated: z.boolean(),
  /** Rated books in the profile used, and the thresholds, for the below-floor and low-confidence messages. */
  ratedCount: z.int().min(0),
  hardFloor: z.int().positive(),
  minForConfidence: z.int().positive(),
  generatedAt: z.iso.datetime().nullable(),
  similarRatedBooks: z.array(similarRatedBookSchema),
  traits: z.array(traitFitSchema),
  /** Set only when `status` is `failed`. */
  errorCode: errorCode.nullable(),
});

const feedbackSchema = z.object({
  public: z.enum(CONTRACT_ENUMS.feedbackValue).nullable(),
  personal: z.enum(CONTRACT_ENUMS.feedbackValue).nullable(),
});

type AnalysisShape = z.infer<typeof analysisShape>;

const analysisShape = z.object({
  id: z.uuid(),
  status: z.enum(CONTRACT_ENUMS.analysisStatus),
  /** How long to wait before polling again; null once the analysis is finished. */
  pollAfterMs: z.int().positive().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** The analysis this one recalculated, if any. */
  recalculatedFromId: z.uuid().nullable(),
  /** True when at least one step failed and `POST /analyses/:id/retry` will run it again. */
  canRetry: z.boolean(),
  edition: editionDetailsSchema,
  /** All eight steps, in `stepName` order (RES-2). */
  steps: z.array(stepSchema),
  publicReception: publicReceptionSchema,
  personalMatch: personalMatchSchema,
  feedback: feedbackSchema,
});

/** Rules a JSON schema cannot express. Each one is a contract meaning rule (CONTRACT 4.4). */
function checkAnalysis(a: AnalysisShape, ctx: z.RefinementCtx): void {
  const problem = (message: string) => ctx.addIssue({ code: 'custom', message });
  const pr = a.publicReception;
  const pm = a.personalMatch;

  const names = a.steps.map((s) => s.name).join(',');
  if (names !== CONTRACT_ENUMS.stepName.join(','))
    problem('steps must list all eight steps in stepName order');
  for (const step of a.steps) {
    if ((step.status === 'failed') !== (step.errorCode !== null))
      problem(`step ${step.name}: errorCode is set exactly when the step failed`);
  }
  const failedSteps = a.steps.some((s) => s.status === 'failed');
  if (a.canRetry && !failedSteps) problem('canRetry needs a failed step');

  if ((a.status === 'running') !== (a.pollAfterMs !== null))
    problem('pollAfterMs is set exactly while running');
  if ((a.status === 'running') !== (a.finishedAt === null))
    problem('finishedAt is set exactly when the analysis is no longer running');

  // RES-5: every cited evidence id is in the response.
  const ids = new Set(pr.evidence.map((e) => e.id));
  const cited = [
    ...pr.praises.flatMap((c) => c.evidenceIds),
    ...pr.complaints.flatMap((c) => c.evidenceIds),
    ...pr.traits.flatMap((t) => t.evidenceIds),
    ...pm.traits.flatMap((t) => t.evidenceIds),
  ];
  for (const id of cited) if (!ids.has(id)) problem(`evidence ${id} is cited but not included`);
  for (const id of ids)
    if (!cited.includes(id)) problem(`evidence ${id} is included but not cited`);
  for (const e of pr.evidence) {
    if (!e.displayAllowed && e.excerpt !== null)
      problem('excerpt must be null when display is not allowed');
  }
  for (const t of pr.traits) {
    if (t.values.length === 0 && t.evidenceIds.length > 0)
      problem('an unknown trait cites no evidence');
  }

  // RES-3, RES-4: no written verdict without evidence; all sources failed is a failure.
  if (
    pr.summary !== null &&
    (pr.evidenceState === 'insufficient' || pr.evidenceState === 'unavailable')
  )
    problem('no summary when evidence is insufficient or unavailable');
  if (pr.evidenceState === 'unavailable' && a.status !== 'failed')
    problem('all sources failed means the analysis failed');
  if (pr.status !== 'done' && (pr.summary !== null || pr.praises.length + pr.complaints.length > 0))
    problem('public reception content only once done');

  // PERF-3: an older reception is shown only because a public step failed, and
  // then the analysis is partial (the reception is shown with something missing).
  const publicStepFailed = a.steps.some(
    (s) => s.status === 'failed' && s.name !== 'personalMatch' && s.name !== 'finalize',
  );
  if (pr.stale && (pr.status !== 'done' || !publicStepFailed))
    problem('stale means a public step failed and the older reception is shown');
  if (pr.stale && a.status === 'failed')
    problem('an analysis showing a stale reception is partial');

  // MODEL-4 and D-010: a score only when the match is done, on the 1 to 5 scale.
  if ((pm.status === 'done') !== (pm.score !== null))
    problem('score is set exactly when status is done');
  if (pm.score !== null && Math.round(pm.score * 10) !== pm.score * 10)
    problem('score has one decimal');
  if (
    pm.status === 'done' &&
    (pm.modelId === null || pm.modelVersion === null || pm.evidenceConfidence === null)
  )
    problem('a score records its model, version and confidence (MODEL-3)');
  if (pm.isFallback && !(pm.modelId === 'B0' || pm.modelId === 'B1'))
    problem('only B0 and B1 are fallbacks');
  if (pm.isFallback && pm.evidenceConfidence?.level !== 'low')
    problem('a fallback score has low confidence');
  if ((pm.status === 'failed') !== (pm.errorCode !== null))
    problem('personalMatch.errorCode is set exactly when it failed');
  if (pm.status !== 'done' && (pm.similarRatedBooks.length > 0 || pm.traits.length > 0))
    problem('explanations only come with a score');
  if (pm.isOutdated && pm.tasteProfileVersion === pm.currentTasteProfileVersion)
    problem('isOutdated means a newer profile version exists');

  // FB: feedback only on sections that were generated.
  if (a.feedback.public !== null && pr.status !== 'done')
    problem('no public feedback before it is done');
  if (a.feedback.personal !== null && pm.status !== 'done')
    problem('no personal feedback without a score');
}

export const analysisSchema = responseSchema('Analysis', analysisShape.superRefine(checkAnalysis));

/** A history row (GET /analyses): enough to list and filter, without the evidence. */
export const analysisSummarySchema = responseSchema(
  'AnalysisSummary',
  z.object({
    id: z.uuid(),
    status: z.enum(CONTRACT_ENUMS.analysisStatus),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    edition: candidateSchema,
    publicReception: publicReceptionSchema.pick({
      status: true,
      stale: true,
      evidenceState: true,
      summary: true,
      evidenceConfidence: true,
    }),
    personalMatch: personalMatchSchema.pick({
      status: true,
      score: true,
      scale: true,
      modelId: true,
      isFallback: true,
      evidenceConfidence: true,
      tasteProfileVersion: true,
      currentTasteProfileVersion: true,
      isOutdated: true,
    }),
    feedback: feedbackSchema,
  }),
);

export const analysisListSchema = responseSchema(
  'AnalysisList',
  z.object({ items: z.array(analysisSummarySchema), nextCursor: z.string().nullable() }),
);

export const startAnalysisSchema = requestSchema(
  'StartAnalysis',
  z.object({
    editionId: z.uuid({ error: 'Choose a book first.' }),
    /**
     * Build the public reception again even when a fresh one exists (spec 10
     * "user refresh"), limited per reader and book per day. If the rebuild
     * fails, the older reception is shown as `stale` (PERF-3).
     */
    refresh: z.boolean().optional(),
  }),
);

export const retryAnalysisSchema = requestSchema(
  'RetryAnalysis',
  z.object({
    /** Failed steps to run again; all failed steps when left out. Done steps are never repeated (RES-2). */
    steps: z.array(z.enum(CONTRACT_ENUMS.stepName)).min(1).optional(),
  }),
);

export type Analysis = z.infer<typeof analysisSchema>;
export type AnalysisSummary = z.infer<typeof analysisSummarySchema>;
