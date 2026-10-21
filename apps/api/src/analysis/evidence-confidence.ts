/**
 * Evidence state and public evidence confidence, computed in code, never by
 * the language model (spec 4, spec 8, D-021). Pure, so the same inputs always
 * give the same result.
 */

export type EvidenceState = 'sufficient' | 'limited' | 'insufficient' | 'unavailable';
export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface SourceSummary {
  name: string;
  outcome: 'ok' | 'empty' | 'failed' | 'rate_limited' | 'not_permitted';
  ratingCount: number | null;
}

export interface EvidenceInputs {
  sources: SourceSummary[];
  /** Usable reviews with text in the evidence set. */
  textReviews: number;
  /** Text sources those reviews came from. */
  textSources: number;
  /** Reviews in the set rated 4 or 5, and 1 or 2. */
  positive: number;
  negative: number;
}

export interface Thresholds {
  /** EVIDENCE_SUFFICIENT_REVIEWS */
  sufficientReviews: number;
  /** PUBLIC_CONFIDENCE_HIGH_REVIEWS */
  highReviews: number;
}

const failed = (s: SourceSummary) => s.outcome === 'failed' || s.outcome === 'rate_limited';

/** Spec 8 table. A source failure is never read as "no reviews" (RES-4). */
export function evidenceStateOf(input: EvidenceInputs, t: Thresholds): EvidenceState {
  if (input.sources.length > 0 && input.sources.every(failed)) return 'unavailable';
  if (input.textReviews === 0) return 'insufficient';
  if (input.textReviews < t.sufficientReviews || input.sources.some(failed)) return 'limited';
  return 'sufficient';
}

const LEVELS: ConfidenceLevel[] = ['low', 'medium', 'high'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Level plus plain reasons (CONTRACT 4.4: no numeric score, D-010). The level
 * starts from the number of reviews with text, then drops one step per failed
 * source and when only praise or only complaints are present.
 */
export function publicConfidence(
  input: EvidenceInputs,
  t: Thresholds,
): { level: ConfidenceLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level = 0;
  if (input.textReviews === 0) {
    reasons.push('No reviews with text');
  } else {
    reasons.push(
      `${plural(input.textReviews, 'review')} with text from ${plural(Math.max(1, input.textSources), 'source')}`,
    );
    level =
      input.textReviews >= t.highReviews ? 2 : input.textReviews >= t.sufficientReviews ? 1 : 0;
  }

  const rated = input.sources.filter((s) => s.outcome === 'ok' && (s.ratingCount ?? 0) > 0);
  if (rated.length === 1) {
    reasons.push(`${plural(rated[0]!.ratingCount!, 'rating')} from 1 source`);
  } else if (rated.length > 1) {
    reasons.push(`Ratings from ${rated.length} sources`);
  }

  for (const s of input.sources.filter(failed)) {
    reasons.push(
      s.outcome === 'rate_limited'
        ? `${s.name} limited our requests`
        : `${s.name} could not be reached`,
    );
    level = Math.max(0, level - 1);
  }

  if (input.textReviews > 0) {
    if (input.positive > 0 && input.negative > 0) {
      reasons.push('Praise and complaints both represented');
    } else {
      reasons.push(
        input.negative === 0
          ? 'No critical reviews in the sample'
          : 'No positive reviews in the sample',
      );
      level = Math.min(level, 1);
    }
  }
  return { level: LEVELS[level]!, reasons };
}
