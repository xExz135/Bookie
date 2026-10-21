import type { Analysis } from '../analysis/analysis.schemas';
import { traitDifferences } from './compare.service';
import { readingListSchema, type ReadingListItem } from './reader-data.schemas';
import { groupOf, orderReadingList } from './reading-list.service';

type Match = NonNullable<ReadingListItem['personalMatch']>;

const match = (over: Partial<Match> = {}): Match => ({
  status: 'done',
  score: 4,
  scale: { min: 1, max: 5 },
  modelId: 'B4',
  isFallback: false,
  evidenceConfidence: { level: 'medium', reasons: ['r'] },
  tasteProfileVersion: 1,
  currentTasteProfileVersion: 1,
  isOutdated: false,
  ...over,
});

let n = 0;
const item = (pm: Match | null, addedAt: string): ReadingListItem => {
  n += 1;
  return {
    edition: {
      editionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      title: `Book ${n}`,
      subtitle: null,
      author: null,
      year: null,
      language: null,
      publisher: null,
      format: null,
      coverUrl: null,
    },
    addedAt,
    analysisId: pm ? `10000000-0000-4000-8000-${String(n).padStart(12, '0')}` : null,
    group: groupOf(pm),
    personalMatch: pm,
  };
};

describe('reading list rules (LIST-1, LIST-2)', () => {
  it('LIST-2: only a medium or high confidence score from a learned model is ranked', () => {
    expect(groupOf(match())).toBe('ranked');
    expect(groupOf(match({ evidenceConfidence: { level: 'high', reasons: [] } }))).toBe('ranked');
    expect(groupOf(match({ evidenceConfidence: { level: 'low', reasons: [] } }))).toBe(
      'low_confidence',
    );
    expect(groupOf(match({ isFallback: true, modelId: 'B1' }))).toBe('low_confidence');
    expect(groupOf(match({ evidenceConfidence: null }))).toBe('low_confidence');
    expect(groupOf(match({ status: 'below_floor', score: null }))).toBe('no_match');
    expect(groupOf(null)).toBe('no_match');
  });

  it('LIST-1: ranked by score, then labeled groups newest first, with a stable tie-break', () => {
    const ranked45 = item(match({ score: 4.5 }), '2026-10-01T00:00:00.000Z');
    const ranked48 = item(match({ score: 4.8 }), '2026-09-01T00:00:00.000Z');
    const lowOld = item(
      match({
        score: 5,
        isFallback: true,
        modelId: 'B0',
        evidenceConfidence: { level: 'low', reasons: [] },
      }),
      '2026-08-01T00:00:00.000Z',
    );
    const lowNew = item(
      match({ score: 1.5, evidenceConfidence: { level: 'low', reasons: [] } }),
      '2026-10-05T00:00:00.000Z',
    );
    const none = item(null, '2026-10-06T00:00:00.000Z');
    const ordered = orderReadingList([none, lowOld, ranked45, lowNew, ranked48]);
    expect(ordered).toEqual([ranked48, ranked45, lowNew, lowOld, none]);
    expect(readingListSchema.safeParse({ items: ordered }).success).toBe(true);
    // The schema refuses an order the API must never send.
    expect(readingListSchema.safeParse({ items: [ranked45, ranked48] }).success).toBe(false);
    expect(readingListSchema.safeParse({ items: [lowNew, ranked45] }).success).toBe(false);
    expect(readingListSchema.safeParse({ items: [{ ...lowNew, group: 'ranked' }] }).success).toBe(
      false,
    );
  });
});

describe('trait differences (compare)', () => {
  const withTraits = (traits: Array<[string, string[]]>) =>
    ({
      publicReception: {
        traits: traits.map(([trait, values]) => ({ trait, values, evidenceIds: [] })),
      },
    }) as unknown as Analysis;

  it('lists only traits whose values differ, compared as sets; unknown on one side is a difference', () => {
    const a = withTraits([
      ['pace', ['fast']],
      ['tone', ['tense', 'dark']],
      ['themes', ['survival']],
    ]);
    const b = withTraits([
      ['pace', ['fast']],
      ['tone', ['dark', 'tense']],
      ['themes', []],
      ['contentIntensity', ['low']],
    ]);
    expect(traitDifferences(a, b)).toEqual([
      { trait: 'themes', a: ['survival'], b: [] },
      { trait: 'contentIntensity', a: [], b: ['low'] },
    ]);
  });

  it('unknown on both sides is not a difference', () => {
    expect(traitDifferences(withTraits([]), withTraits([['pace', []]]))).toEqual([]);
  });
});
