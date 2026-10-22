import { traitExtractLimit } from './trait-extract-limit';

describe('trait extraction cap (D-023)', () => {
  it('allows the evaluation set and anything smaller', () => {
    expect(traitExtractLimit(1000, 1000)).toBe(1000);
    expect(traitExtractLimit(100, 1000)).toBe(100);
  });

  it('refuses more books than the cap, naming the setting to change', () => {
    expect(() => traitExtractLimit(5000, 1000)).toThrow(/TRAITS_EXTRACT_MAX_BOOKS \(1000\)/);
  });

  it('allows more once the cap is raised on purpose', () => {
    expect(traitExtractLimit(5000, 5000)).toBe(5000);
  });
});
