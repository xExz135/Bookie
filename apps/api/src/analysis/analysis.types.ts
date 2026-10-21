import type { ErrorCode } from '../contract/error-codes';
import type { ExtractedTraits } from '../representation/traits';
import type { ConfidenceLevel, EvidenceInputs, EvidenceState } from './evidence-confidence';
import type { PublicSummary } from './public-summary';

/** CONTRACT 3 `stepName`, in run order. */
export const STEP_ORDER = [
  'resolve',
  'fetchReviews',
  'selectReviews',
  'extractTraits',
  'publicSummary',
  'evidenceConfidence',
  'personalMatch',
  'finalize',
] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** Steps that build the shared public reception. */
export const PUBLIC_STEPS: readonly StepName[] = STEP_ORDER.slice(0, 6);

/** A step that ended in a known way. `output` is kept even on failure, e.g. which sources failed. */
export class StepError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly output: unknown = null,
  ) {
    super(code);
    this.name = 'StepError';
  }
}

/** One source as recorded for this analysis (no numbers from a source that may not be stored). */
export interface StoredSource {
  key: string;
  name: string;
  outcome: 'ok' | 'empty' | 'failed' | 'rate_limited' | 'not_permitted';
  providesText: boolean;
  storageAllowed: boolean;
  ratingAverage: number | null;
  ratingCount: number | null;
  ratingScope: 'edition' | 'work' | null;
  detail: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
}

export interface ResolveOutput {
  /** A fresh public analysis of this edition was reused (spec 10); the public steps did not run. */
  reusedPublicAnalysisId: string | null;
  /** Time spent waiting for another analysis's build of the same book (PERF-2). */
  waitedMs?: number;
}

export interface FetchOutput {
  sources: StoredSource[];
}

export interface SelectOutput {
  /** Review IDs and their stable numbers; the text stays in the reviews table. */
  selected: Array<{ position: number; reviewId: string; sourceKey: string; rating: number | null }>;
  dropped: Record<string, number>;
  evidenceState: EvidenceState;
  inputs: EvidenceInputs;
}

export interface TraitsOutput {
  /** Null when there was nothing to read (no reviews, no description): every trait unknown. */
  traits: ExtractedTraits | null;
  model: string | null;
  promptVersion: string | null;
  /** The analysis whose output was reused because the evidence was the same (D-025). */
  reusedFrom?: string;
}

export interface SummaryOutput {
  /** Null when evidence is insufficient: no written verdict (RES-3). */
  summary: PublicSummary | null;
  model: string | null;
  promptVersion: string | null;
  /** The analysis whose output was reused because the evidence was the same (D-025). */
  reusedFrom?: string;
}

export interface ConfidenceOutput {
  publicAnalysisId: string;
  level: ConfidenceLevel;
  reasons: string[];
}

export interface PersonalOutput {
  outcome: 'scored' | 'below_floor' | 'needs_taste_data';
}
