import { createHash } from 'node:crypto';

/**
 * Stable order by the hash of the seed and each item's key: random, and the
 * same every time (the LLM evaluation set and its claim sample, D-028).
 */
export function seededOrder<T>(items: readonly T[], key: (item: T) => string, seed: number): T[] {
  const h = (item: T) =>
    createHash('sha256')
      .update(`${seed}:${key(item)}`)
      .digest('hex');
  return [...items].sort((a, b) => h(a).localeCompare(h(b)));
}
