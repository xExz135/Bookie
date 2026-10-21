import { normalizeForSearch } from '../catalog/normalize';

/**
 * Selects the bounded evidence set for one edition (spec 8): deduplicate,
 * filter language and length, apply per-source limits, balance positive and
 * negative reviews, truncate. Pure and deterministic: the same reviews and
 * options always give the same set in the same order (MODEL-1).
 */

export interface CandidateReview {
  id: string;
  sourceKey: string;
  /** 1 to 5, or null when the reviewer gave no rating. */
  rating: number | null;
  text: string;
}

export type Sentiment = 'positive' | 'negative' | 'mixed' | 'unrated';

export interface SelectedReview {
  /** 1..N, the stable "Review #n" number used in citations. */
  position: number;
  id: string;
  sourceKey: string;
  rating: number | null;
  sentiment: Sentiment;
  /** Possibly truncated. */
  text: string;
  truncated: boolean;
}

export interface SelectionOptions {
  maxReviews: number;
  minChars: number;
  maxChars: number;
  /** Allowed languages (ISO 639-1). A review whose language cannot be detected is dropped. */
  languages: string[];
  /** Most reviews taken from one source. Defaults to maxReviews. */
  perSourceLimit?: number;
  detectLanguage: (text: string) => string | null;
}

export interface SelectionResult {
  selected: SelectedReview[];
  dropped: { tooShort: number; duplicate: number; language: number; overLimit: number };
}

export function sentimentOf(rating: number | null): Sentiment {
  if (rating === null) return 'unrated';
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  return 'mixed';
}

/** Cuts text at a word boundary and marks the cut with an ellipsis. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return { text: `${base.trimEnd()}…`, truncated: true };
}

export function selectEvidence(
  reviews: CandidateReview[],
  options: SelectionOptions,
): SelectionResult {
  const dropped = { tooShort: 0, duplicate: 0, language: 0, overLimit: 0 };
  const allowed = new Set(options.languages);
  const seenTexts = new Set<string>();

  // Stable order regardless of how the database returned the rows.
  const ordered = [...reviews].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const buckets: Record<Sentiment, CandidateReview[]> = {
    negative: [],
    positive: [],
    mixed: [],
    unrated: [],
  };
  for (const review of ordered) {
    const text = review.text.trim();
    if (text.length < options.minChars) {
      dropped.tooShort++;
      continue;
    }
    const key = normalizeForSearch(text);
    if (seenTexts.has(key)) {
      dropped.duplicate++;
      continue;
    }
    seenTexts.add(key);
    const language = options.detectLanguage(text);
    if (!language || !allowed.has(language)) {
      dropped.language++;
      continue;
    }
    buckets[sentimentOf(review.rating)].push({ ...review, text });
  }

  // Round-robin across sentiments so praise and complaints are both
  // represented even when one side dominates (spec 8: balance).
  const order: Sentiment[] = ['negative', 'positive', 'mixed', 'unrated'];
  const perSourceLimit = options.perSourceLimit ?? options.maxReviews;
  const perSource = new Map<string, number>();
  const selected: SelectedReview[] = [];
  const cursors: Record<Sentiment, number> = { negative: 0, positive: 0, mixed: 0, unrated: 0 };
  let progress = true;
  while (selected.length < options.maxReviews && progress) {
    progress = false;
    for (const sentiment of order) {
      if (selected.length >= options.maxReviews) break;
      const bucket = buckets[sentiment];
      while (cursors[sentiment] < bucket.length) {
        const review = bucket[cursors[sentiment]++]!;
        const used = perSource.get(review.sourceKey) ?? 0;
        if (used >= perSourceLimit) {
          dropped.overLimit++;
          continue;
        }
        perSource.set(review.sourceKey, used + 1);
        const { text, truncated } = truncate(review.text, options.maxChars);
        selected.push({
          position: selected.length + 1,
          id: review.id,
          sourceKey: review.sourceKey,
          rating: review.rating,
          sentiment,
          text,
          truncated,
        });
        progress = true;
        break;
      }
    }
  }
  for (const sentiment of order) {
    dropped.overLimit += buckets[sentiment].length - cursors[sentiment];
  }
  return { selected, dropped };
}
