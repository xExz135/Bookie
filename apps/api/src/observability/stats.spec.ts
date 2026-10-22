import { bootstrap, mean, quantile, seededRandom, wilson } from './stats';

describe('report statistics (H4, D-026)', () => {
  it('quantiles interpolate between order statistics like numpy', () => {
    const values = [10, 1, 4, 7, 2];
    expect(quantile(values, 0.5)).toBe(4);
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(10);
    // numpy.percentile([1, 2, 4, 7, 10], 95) = 9.4
    expect(quantile(values, 0.95)).toBeCloseTo(9.4, 10);
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([3], 0.95)).toBe(3);
  });

  it('the seeded generator repeats and stays in [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const first = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(first[0]);
  });

  it('a bootstrap interval is reproducible and contains the estimate', () => {
    const values = Array.from({ length: 40 }, (_, i) => 10_000 + ((i * 7919) % 5000));
    const options = { resamples: 1000, seed: 20261022 };
    const p50 = bootstrap(values, (v) => quantile(v, 0.5), options);
    expect(bootstrap(values, (v) => quantile(v, 0.5), options)).toEqual(p50);
    expect(p50.n).toBe(40);
    expect(p50.low!).toBeLessThanOrEqual(p50.value!);
    expect(p50.high!).toBeGreaterThanOrEqual(p50.value!);
    const m = bootstrap(values, mean, options);
    expect(m.value).toBeCloseTo(mean(values)!, 10);
  });

  it('gives no interval for fewer than two values', () => {
    expect(bootstrap([5], mean, { resamples: 100, seed: 1 })).toEqual({
      value: 5,
      low: null,
      high: null,
      n: 1,
    });
    expect(bootstrap([], mean, { resamples: 100, seed: 1 }).value).toBeNull();
  });

  it('a Wilson interval stays inside 0 to 1 and matches a known value', () => {
    // 8 of 10: 95% Wilson interval 0.490 to 0.943.
    const r = wilson(8, 10);
    expect(r.value).toBe(0.8);
    expect(r.low).toBeCloseTo(0.4902, 3);
    expect(r.high).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 5).low).toBe(0);
    expect(wilson(5, 5).high).toBe(1);
    expect(wilson(0, 0).value).toBeNull();
  });
});
