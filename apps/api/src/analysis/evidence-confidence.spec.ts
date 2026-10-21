import { type EvidenceInputs, evidenceStateOf, publicConfidence } from './evidence-confidence';

const t = { sufficientReviews: 10, highReviews: 40 };
const dataset = {
  name: 'Goodreads (UCSD Book Graph dataset)',
  outcome: 'ok' as const,
  ratingCount: 5000,
};
const openLibrary = { name: 'Open Library', outcome: 'ok' as const, ratingCount: 570 };
const input = (over: Partial<EvidenceInputs>): EvidenceInputs => ({
  sources: [dataset, openLibrary],
  textReviews: 75,
  textSources: 1,
  positive: 40,
  negative: 20,
  ...over,
});

describe('Evidence state and public confidence, computed in code (spec 8, D-021)', () => {
  it('follows the spec 8 table', () => {
    expect(evidenceStateOf(input({}), t)).toBe('sufficient');
    expect(evidenceStateOf(input({ textReviews: 9 }), t)).toBe('limited');
    expect(
      evidenceStateOf(input({ sources: [dataset, { ...openLibrary, outcome: 'failed' }] }), t),
    ).toBe('limited');
    expect(evidenceStateOf(input({ textReviews: 0 }), t)).toBe('insufficient');
  });

  it('RES-4: every source failing is unavailable, never insufficient', () => {
    const failed = [
      { ...dataset, outcome: 'failed' as const },
      { ...openLibrary, outcome: 'rate_limited' as const },
    ];
    expect(evidenceStateOf(input({ sources: failed, textReviews: 0 }), t)).toBe('unavailable');
  });

  it('gives a level with plain reasons and no number (D-010)', () => {
    expect(publicConfidence(input({}), t)).toEqual({
      level: 'high',
      reasons: [
        '75 reviews with text from 1 source',
        'Ratings from 2 sources',
        'Praise and complaints both represented',
      ],
    });
    expect(publicConfidence(input({ textReviews: 12 }), t).level).toBe('medium');
  });

  it('lowers the level for each failed source and says which', () => {
    const result = publicConfidence(
      input({
        textReviews: 9,
        sources: [dataset, { ...openLibrary, outcome: 'failed', ratingCount: null }],
      }),
      t,
    );
    expect(result).toEqual({
      level: 'low',
      reasons: [
        '9 reviews with text from 1 source',
        '5000 ratings from 1 source',
        'Open Library could not be reached',
        'Praise and complaints both represented',
      ],
    });
    expect(
      publicConfidence(
        input({ sources: [dataset, { ...openLibrary, outcome: 'rate_limited' }] }),
        t,
      ),
    ).toMatchObject({
      level: 'medium',
      reasons: expect.arrayContaining(['Open Library limited our requests']),
    });
  });

  it('caps the level when only praise (or only complaints) is in the sample', () => {
    const result = publicConfidence(input({ negative: 0 }), t);
    expect(result.level).toBe('medium');
    expect(result.reasons).toContain('No critical reviews in the sample');
  });

  it('no text at all: low, said plainly, ratings still counted', () => {
    expect(
      publicConfidence(
        input({
          textReviews: 0,
          positive: 0,
          negative: 0,
          sources: [{ ...openLibrary, ratingCount: 12 }],
        }),
        t,
      ),
    ).toEqual({ level: 'low', reasons: ['No reviews with text', '12 ratings from 1 source'] });
  });
});
