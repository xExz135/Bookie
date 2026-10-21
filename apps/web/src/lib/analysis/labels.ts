import type { Analysis, Evidence, PersonalMatch, PublicReception, StepName } from './api';

/** The eight steps of the progress rail (CONTRACT 3 `stepName`, D-010 point 7). */
export const STEP_LABELS: Record<StepName, string> = {
  resolve: 'Edition',
  fetchReviews: 'Reviews and ratings',
  selectReviews: 'Evidence',
  extractTraits: 'Traits',
  publicSummary: 'Public summary',
  evidenceConfidence: 'Confidence',
  personalMatch: 'Personal match',
  finalize: 'Ready',
};

export const STEP_STATUS_LABELS: Record<Analysis['steps'][number]['status'], string> = {
  pending: 'Waiting',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

/**
 * Which steps build which section, so each section can retry its own failed
 * steps (spec 8 lists the public steps first, then the personal match).
 */
export const PUBLIC_STEPS: readonly StepName[] = [
  'resolve',
  'fetchReviews',
  'selectReviews',
  'extractTraits',
  'publicSummary',
  'evidenceConfidence',
];
export const PERSONAL_STEPS: readonly StepName[] = ['personalMatch'];

export const TRAIT_LABELS: Record<PublicReception['traits'][number]['trait'], string> = {
  pace: 'Pace',
  tone: 'Tone',
  themes: 'Themes',
  contentIntensity: 'Content intensity',
};

/** The models of spec 7, named as the evaluation names them. */
export const MODEL_NAMES: Record<NonNullable<PersonalMatch['modelId']>, string> = {
  B0: 'global average rating',
  B1: 'questionnaire and trait match',
  B2: 'taste vector',
  B3: 'collaborative model',
  B4: 'hybrid model',
};

export const CONFIDENCE_LABELS = { low: 'Low', medium: 'Medium', high: 'High' } as const;

export const SOURCE_OUTCOME_LABELS: Record<PublicReception['sources'][number]['outcome'], string> =
  {
    ok: 'Responded',
    empty: 'Has no ratings for this book',
    failed: 'Could not be reached',
    rate_limited: 'Asked us to slow down; not checked this time',
    not_permitted: 'Not used: its terms do not allow it',
  };

/** "Review #12", or what else the cited item is. */
export function evidenceLabel(item: Evidence): string {
  if (item.kind === 'description') return 'Book description';
  if (item.kind === 'source_aggregate') return `Source summary #${item.number}`;
  return `Review #${item.number}`;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const countFormat = new Intl.NumberFormat('en');

/** "21 Oct 2026" in the reader's time zone. */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** "21 Oct 2026, 08:30" in the reader's time zone. */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

/** "4,899,965". */
export function formatCount(n: number): string {
  return countFormat.format(n);
}
