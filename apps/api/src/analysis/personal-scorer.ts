import type { ModelId } from '../contract/enums';

/**
 * Where the personal match gets its score (spec 7). BE-13's TasteModelScorer
 * serves the models trained and evaluated in eval/ (D-006, D-024). With no
 * release loaded, `score` returns null and the personal step reports
 * MODEL_UNAVAILABLE (D-021).
 */
export const PERSONAL_SCORER = Symbol('PERSONAL_SCORER');

export interface PersonalScoreInput {
  userId: string;
  editionId: string;
  tasteProfileVersionId: string;
  /** The book's public analysis, whose traits B1 and the explanations read. */
  publicAnalysisId: string | null;
  /**
   * Rated books left out of the profile, as if the reader had not rated them:
   * the user study's held-out books (spec 9, D-027). The analysis never sets it.
   */
  excludeEditionIds?: string[];
}

export interface PersonalScore {
  modelVersionId: string;
  modelId: ModelId;
  /** 1 to 5; not a probability of enjoyment (D-007). */
  score: number;
  /** Computed in code, never by the language model. */
  confidence: { level: 'low' | 'medium' | 'high'; reasons: string[] };
  /** The reader's rated books most similar to this one, by the model's own similarity. */
  similarBooks: Array<{ editionId: string; yourRating: number; similarity: number }>;
  /** The book's traits against the reader's stated preferences. */
  traitFits: Array<{
    trait: 'pace' | 'tone' | 'themes' | 'contentIntensity';
    fit: 'aligned' | 'conflicting' | 'unknown';
    bookTraitId: string | null;
  }>;
}

export interface PersonalScorer {
  /** True when a model can score; a retry of MODEL_UNAVAILABLE is only offered then. */
  available(): Promise<boolean>;
  /** Null when no model is loaded. */
  score(input: PersonalScoreInput): Promise<PersonalScore | null>;
}

/** No model loaded (tests that need MODEL_UNAVAILABLE use it). */
export class NoModelScorer implements PersonalScorer {
  async available(): Promise<boolean> {
    return false;
  }

  async score(): Promise<null> {
    return null;
  }
}
