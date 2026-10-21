import { Injectable } from '@nestjs/common';
import { AnalysisView } from '../analysis/analysis-view';
import type { Analysis } from '../analysis/analysis.schemas';
import { ApiError } from '../common/api-error';
import { CONTRACT_ENUMS } from '../contract/enums';
import type { Comparison } from './reader-data.schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The book's values for one trait; an empty list means unknown. */
function valuesOf(analysis: Analysis, trait: (typeof CONTRACT_ENUMS.traitKey)[number]): string[] {
  return analysis.publicReception.traits.find((t) => t.trait === trait)?.values ?? [];
}

/**
 * The traits whose values differ between two analysed books (spec 6,
 * Compare), computed in code. Values are compared as sets, so order does not
 * matter. A trait unknown on one side and known on the other is a difference
 * the reader should see; unknown on both is not.
 */
export function traitDifferences(a: Analysis, b: Analysis): Comparison['traitDifferences'] {
  return CONTRACT_ENUMS.traitKey.flatMap((trait) => {
    const av = valuesOf(a, trait);
    const bv = valuesOf(b, trait);
    const same = av.length === bv.length && av.every((v) => bv.includes(v));
    return same ? [] : [{ trait, a: av, b: bv }];
  });
}

/** Two of the reader's own analyses side by side (CONTRACT 4.5). */
@Injectable()
export class CompareService {
  constructor(private readonly view: AnalysisView) {}

  async compare(userId: string, aId: unknown, bId: unknown): Promise<Comparison> {
    const fields: Record<string, string> = {};
    if (typeof aId !== 'string' || !UUID.test(aId)) fields.a = 'Give an analysis id.';
    if (typeof bId !== 'string' || !UUID.test(bId)) fields.b = 'Give an analysis id.';
    if (Object.keys(fields).length === 0 && aId === bId)
      fields.b = 'Choose two different analyses.';
    if (Object.keys(fields).length > 0) throw new ApiError('VALIDATION_FAILED', { fields });

    const [a, b] = await Promise.all([
      this.view.get(userId, aId as string),
      this.view.get(userId, bId as string),
    ]);
    // Either one missing or another reader's: 404, never saying which (SEC-1).
    if (!a || !b) throw new ApiError('NOT_FOUND');
    return { a, b, traitDifferences: traitDifferences(a, b) };
  }
}
