/**
 * Where the personal match gets its score (spec 7). The taste models B0 to B4
 * are built in BE-13 and served per D-006 (Python artifacts, TypeScript
 * scoring). Until one is shipped, `score` returns null and the personal step
 * reports MODEL_UNAVAILABLE (D-021).
 */
export const PERSONAL_SCORER = Symbol('PERSONAL_SCORER');

export interface PersonalScoreInput {
  userId: string;
  editionId: string;
  tasteProfileVersionId: string;
}

export interface PersonalScorer {
  /** True when a shipped model can score; a retry of MODEL_UNAVAILABLE is only offered then. */
  available(): Promise<boolean>;
  /** Null when no model is shipped. */
  score(input: PersonalScoreInput): Promise<{ score: number } | null>;
}

/** No model shipped yet (BE-13 replaces this provider). */
export class NoModelScorer implements PersonalScorer {
  async available(): Promise<boolean> {
    return false;
  }

  async score(): Promise<null> {
    return null;
  }
}
