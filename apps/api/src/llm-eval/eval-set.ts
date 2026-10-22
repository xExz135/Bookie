import { createHash } from 'node:crypto';

/**
 * Stable order by the hash of the seed and each item's key: random, and the
 * same every time (the LLM evaluation set and its claim sample, D-028).
 */
export function seededOrder<T>(items: readonly T[], key: (item: T) => string, seed: number): T[] {
  const h = (item: T) =>
    createHash('sha256')
      .update(`${seed}:${key(item)}`)
      .digest('hex');
  return [...items].sort((a, b) => h(a).localeCompare(h(b)));
}

/** A batch trait file written by `traits:extract` (D-023), as far as the evaluation reads it. */
export interface BatchTraitFile {
  editionId: string;
  model: string;
  promptVersion: string;
  reviewsSelected?: number;
  /** Evidence number -> internal review ID: the reviews the model read. */
  citedReviewIds?: Record<string, string>;
  traits?: unknown;
  error?: unknown;
  attempts?: number;
}

/**
 * The hand-labelled set drawn from books that already have batch traits
 * (D-028 update, owner 2026-10-22): a seeded sample of those with enough
 * reviews, failures included (they count as wrong, never left out).
 */
export function chooseFromBatch(
  files: readonly BatchTraitFile[],
  options: { seed: number; books: number; minReviews: number },
): string[] {
  const eligible = files.filter((f) => (f.reviewsSelected ?? 0) >= options.minReviews);
  return seededOrder(eligible, (f) => f.editionId, options.seed)
    .slice(0, options.books)
    .map((f) => f.editionId);
}

/** True when a batch answer read exactly the evidence the evaluation gives the model now. */
export function sameEvidence(
  cited: Record<string, string> | undefined,
  selected: ReadonlyArray<{ position: number; id: string }>,
): boolean {
  if (!cited) return false;
  const now = new Map(selected.map((r) => [String(r.position), r.id]));
  const keys = Object.keys(cited);
  return keys.length === now.size && keys.every((k) => now.get(k) === cited[k]);
}
