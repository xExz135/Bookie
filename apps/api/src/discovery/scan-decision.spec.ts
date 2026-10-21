import { decideScan } from './scan-decision';

const t = { minTitle: 0.7, minAuthor: 0.6 };
const hit = (name: string, titleScore: number | null, authorScore: number | null) => ({
  name,
  titleScore,
  authorScore,
});
const read = (certainty: 'high' | 'medium' | 'low', authors = ['Andy Weir']) => ({
  certainty,
  authors,
});

describe('scan decision (DISC-2: an uncertain scan always ends on the confirmation screen)', () => {
  it('identifies one clear match read with high certainty', () => {
    const result = decideScan(read('high'), [hit('a', 0.95, 1), hit('b', 0.4, 1)], t);
    expect(result.outcome).toBe('identified');
    expect(result.ordered.map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('is uncertain when two books match (never auto-selects)', () => {
    const result = decideScan(read('high'), [hit('a', 0.9, 1), hit('b', 0.8, 0.9)], t);
    expect(result.outcome).toBe('uncertain');
  });

  it('is uncertain when the model was not sure, even with one clear match', () => {
    expect(decideScan(read('medium'), [hit('a', 1, 1)], t).outcome).toBe('uncertain');
    expect(decideScan(read('low'), [hit('a', 1, 1)], t).outcome).toBe('uncertain');
  });

  it('is uncertain when no author was legible', () => {
    expect(decideScan(read('high', []), [hit('a', 1, null)], t).outcome).toBe('uncertain');
  });

  it('is uncertain when the title matches but the author does not', () => {
    expect(decideScan(read('high'), [hit('a', 1, 0.2)], t).outcome).toBe('uncertain');
  });

  it('is uncertain when nothing matches well enough, or nothing was found', () => {
    expect(decideScan(read('high'), [hit('a', 0.69, 1)], t).outcome).toBe('uncertain');
    expect(decideScan(read('high'), [], t).outcome).toBe('uncertain');
  });

  it('lists plausible books first, keeping their order', () => {
    const result = decideScan(
      read('medium'),
      [hit('weak', 0.3, 1), hit('good', 0.9, 1), hit('also good', 0.8, 0.7)],
      t,
    );
    expect(result.ordered.map((h) => h.name)).toEqual(['good', 'also good', 'weak']);
  });
});
