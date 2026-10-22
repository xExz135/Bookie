import { type BatchTraitFile, chooseFromBatch, sameEvidence, seededOrder } from './eval-set';

const file = (i: number, extra: Partial<BatchTraitFile> = {}): BatchTraitFile => ({
  editionId: `ed-${i}`,
  model: 'small',
  promptVersion: 'traits-v1',
  reviewsSelected: 75,
  ...extra,
});

describe('the hand-labelled set from batch traits (D-028 update)', () => {
  const files = Array.from({ length: 50 }, (_, i) => file(i));

  it('is a seeded sample: the same every time, and not simply the first files', () => {
    const a = chooseFromBatch(files, { seed: 7, books: 10, minReviews: 10 });
    expect(a).toEqual(
      chooseFromBatch([...files].reverse(), { seed: 7, books: 10, minReviews: 10 }),
    );
    expect(a).toHaveLength(10);
    expect(a).not.toEqual(files.slice(0, 10).map((f) => f.editionId));
    expect(chooseFromBatch(files, { seed: 8, books: 10, minReviews: 10 })).not.toEqual(a);
  });

  it('keeps failed answers (they count as wrong) but leaves out books with too few reviews', () => {
    const mixed = [
      file(1, { error: { kind: 'INVALID_MODEL_OUTPUT' } }),
      file(2, { reviewsSelected: 4 }),
    ];
    expect(chooseFromBatch(mixed, { seed: 1, books: 10, minReviews: 10 })).toEqual(['ed-1']);
  });

  it('follows the same order as the other seeded samples', () => {
    expect(chooseFromBatch(files, { seed: 3, books: 50, minReviews: 1 })).toEqual(
      seededOrder(files, (f) => f.editionId, 3).map((f) => f.editionId),
    );
  });
});

describe('reusing a batch answer only for the same evidence', () => {
  const selected = [
    { position: 1, id: 'r-a' },
    { position: 2, id: 'r-b' },
  ];

  it('matches the exact reviews in the exact positions', () => {
    expect(sameEvidence({ '1': 'r-a', '2': 'r-b' }, selected)).toBe(true);
  });

  it('refuses other reviews, other positions, more or fewer reviews, or no record', () => {
    expect(sameEvidence({ '1': 'r-b', '2': 'r-a' }, selected)).toBe(false);
    expect(sameEvidence({ '1': 'r-a' }, selected)).toBe(false);
    expect(sameEvidence({ '1': 'r-a', '2': 'r-b', '3': 'r-c' }, selected)).toBe(false);
    expect(sameEvidence(undefined, selected)).toBe(false);
  });
});
