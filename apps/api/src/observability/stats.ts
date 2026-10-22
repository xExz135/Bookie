/**
 * Small statistics for the cost and latency report (D-026). Every interval is
 * reproducible: the bootstrap takes a seed, so the same rows give the same
 * numbers.
 */

/**
 * The q-th quantile (0 to 1) with linear interpolation between order
 * statistics (Hyndman and Fan type 7, numpy's default). Null for no values.
 */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** mulberry32: a small seeded generator, good enough for resampling. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Estimate {
  value: number | null;
  /** 95% percentile-bootstrap interval; null with fewer than two values. */
  low: number | null;
  high: number | null;
  n: number;
}

/** A statistic with its 95% percentile-bootstrap interval over the values. */
export function bootstrap(
  values: readonly number[],
  statistic: (sample: readonly number[]) => number | null,
  options: { resamples: number; seed: number },
): Estimate {
  const value = statistic(values);
  if (values.length < 2) return { value, low: null, high: null, n: values.length };
  const random = seededRandom(options.seed);
  const stats: number[] = [];
  const sample = new Array<number>(values.length);
  for (let r = 0; r < options.resamples; r++) {
    for (let i = 0; i < values.length; i++) {
      sample[i] = values[Math.floor(random() * values.length)]!;
    }
    const s = statistic(sample);
    if (s !== null) stats.push(s);
  }
  return {
    value,
    low: quantile(stats, 0.025),
    high: quantile(stats, 0.975),
    n: values.length,
  };
}

export interface Rate {
  hits: number;
  n: number;
  value: number | null;
  /** 95% Wilson score interval, which stays inside 0 to 1 for small samples. */
  low: number | null;
  high: number | null;
}

export function wilson(hits: number, n: number): Rate {
  if (n === 0) return { hits, n, value: null, low: null, high: null };
  const z = 1.959964;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { hits, n, value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
