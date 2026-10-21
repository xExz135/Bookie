/**
 * The taste models' scoring rules (spec 7, D-006, D-024): the TypeScript twin of
 * `served_scores` in eval/bookie_eval/parity.py. Every function is a small
 * calculation on numbers the release provides; a parity test scores the
 * committed fixture with both and fails beyond 1e-6 (MODEL-1).
 *
 * Unknown preferences and unknown book traits add nothing (MODEL-2).
 */

export const PACES = ['slow', 'moderate', 'fast'] as const;

export interface ReleaseParameters {
  B0: { globalMean: number };
  B1: {
    weightGenre: number;
    weightPace: number;
    weightThemeAvoid: number;
    genreShare: number;
    genreNames: string[];
    sensitivityWeights: Record<string, number>;
    themeMap: Record<string, string>;
  };
  B2: { intercept: number; readerMean: number; cosine: number };
  B3: { globalMean: number; readerShrinkage: number; neighbours: number; weightDamping: number };
  B4: { intercept: number; b2: number; b3: number };
}

/** The reader's questionnaire as stored (D-011). Unanswered = empty or null. */
export interface Answers {
  likedGenres: string[];
  dislikedGenres: string[];
  pace: string | null;
  themesToAvoid: Array<{ theme: string; sensitivity: string }>;
}

/** What B1 needs about the book being scored. */
export interface BookTraitsForB1 {
  genreShares: Record<string, number>;
  /** slow, moderate or fast; anything else is unknown. */
  pace: string | null;
  themes: string[];
}

export function clip(x: number): number {
  return Math.min(5, Math.max(1, x));
}

export function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** B0: the book's average rating; a book the release does not know gets the global mean. */
export function scoreB0(p: ReleaseParameters, itemBias: number | undefined): number {
  return clip(p.B0.globalMean + (itemBias ?? 0));
}

/** Each avoided trait theme with its weight: the strongest sensitivity wins. */
export function avoidWeights(p: ReleaseParameters, answers: Answers): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of answers.themesToAvoid) {
    const theme = p.B1.themeMap[item.theme];
    const weight = p.B1.sensitivityWeights[item.sensitivity];
    if (theme === undefined || weight === undefined) continue;
    out.set(theme, Math.max(out.get(theme) ?? 0, weight));
  }
  return out;
}

export function isPace(value: string | null): value is (typeof PACES)[number] {
  return value !== null && (PACES as readonly string[]).includes(value);
}

/** B1 (the v1 method): reader mean plus fixed-weight matches with the questionnaire. */
export function scoreB1(
  p: ReleaseParameters,
  answers: Answers,
  readerMean: number,
  book: BookTraitsForB1,
): number {
  const b1 = p.B1;
  let liked = 0;
  let disliked = 0;
  for (const genre of b1.genreNames) {
    if ((book.genreShares[genre] ?? 0) < b1.genreShare) continue;
    if (answers.likedGenres.includes(genre)) liked += 1;
    if (answers.dislikedGenres.includes(genre)) disliked += 1;
  }
  let score = readerMean + b1.weightGenre * (liked - disliked);
  if (isPace(answers.pace) && isPace(book.pace)) {
    score += b1.weightPace * (book.pace === answers.pace ? 1 : -1);
  }
  const avoid = avoidWeights(p, answers);
  let avoided = 0;
  for (const theme of book.themes) avoided += avoid.get(theme) ?? 0;
  return clip(score - b1.weightThemeAvoid * avoided);
}

/**
 * Cosine between the book and the reader's taste vector: the rated books'
 * embeddings weighted by rating minus the reader's mean (missing = zero).
 */
export function tasteCosine(
  profile: Array<{ rating: number; embedding: number[] | null }>,
  target: number[] | null,
): number {
  const m = mean(profile.map((r) => r.rating));
  const dim = profile.find((r) => r.embedding)?.embedding?.length ?? target?.length ?? 0;
  const taste = new Array<number>(dim).fill(0);
  for (const r of profile) {
    if (!r.embedding) continue;
    const w = r.rating - m;
    for (let i = 0; i < dim; i++) taste[i]! += w * r.embedding[i]!;
  }
  let norm = 0;
  for (const v of taste) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0 || !target) return 0;
  let dot = 0;
  for (let i = 0; i < dim; i++) dot += target[i]! * (taste[i]! / norm);
  return dot;
}

/** B2: the taste-vector cosine mapped to the scale by the fitted regression. */
export function scoreB2(
  p: ReleaseParameters,
  profile: Array<{ rating: number; embedding: number[] | null }>,
  target: number[] | null,
): number {
  const m = mean(profile.map((r) => r.rating));
  const cos = tasteCosine(profile, target);
  return clip(p.B2.intercept + p.B2.readerMean * m + p.B2.cosine * cos);
}

export interface B3Inputs {
  /** The reader's ratings of books the release knows, in a fixed order. */
  profile: Array<{ rating: number; itemBias: number; similarity: number }>;
  targetBias: number;
}

/**
 * B3: baseline plus the damped, similarity-weighted residuals of the reader's
 * most similar rated books (positive similarities, at most `neighbours`).
 */
export function scoreB3(p: ReleaseParameters, input: B3Inputs): number {
  const { globalMean: mu, readerShrinkage, neighbours, weightDamping } = p.B3;
  const n = input.profile.length;
  let biasSum = 0;
  for (const r of input.profile) biasSum += r.rating - mu - r.itemBias;
  const readerBias = biasSum / (readerShrinkage + n);
  const base = mu + readerBias + input.targetBias;

  let kept = input.profile.map((r, index) => ({
    ...r,
    index,
    sim: r.similarity > 0 ? r.similarity : 0,
  }));
  if (n > neighbours) {
    // Highest similarity first; equal ones keep their order (stable sort).
    kept = [...kept].sort((a, b) => b.sim - a.sim || a.index - b.index).slice(0, neighbours);
  }
  let weight = 0;
  let numerator = 0;
  for (const r of kept) {
    weight += r.sim;
    numerator += r.sim * (r.rating - mu - readerBias - r.itemBias);
  }
  const denominator = weight + weightDamping;
  const adjust = denominator > 0 ? numerator / denominator : 0;
  return clip(base + adjust);
}

/** B4: the blend of B2 and B3 fitted on the validation split. */
export function scoreB4(p: ReleaseParameters, b2: number, b3: number): number {
  return clip(p.B4.intercept + p.B4.b2 * b2 + p.B4.b3 * b3);
}
