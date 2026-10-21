import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../repo-root';
import {
  type Answers,
  type ReleaseParameters,
  mean,
  scoreB0,
  scoreB1,
  scoreB2,
  scoreB3,
  scoreB4,
} from './scoring';

interface FixtureBook {
  embedding: number[] | null;
  genreShares: Record<string, number>;
  pace: string;
  themes: string[];
}

interface Fixture {
  tolerance: number;
  release: {
    knownBooks: string[];
    books: Record<string, FixtureBook>;
    itemBias: Record<string, number>;
    neighbours: Array<[string, string, number]>;
    parameters: ReleaseParameters;
  };
  cases: Array<{
    name: string;
    profile: Array<{ editionId: string; rating: number }>;
    answers: Answers;
    targets: string[];
    expected: Record<'B0' | 'B1' | 'B2' | 'B3' | 'B4', Array<number | null>>;
  }>;
}

/** The parity fixture written by `pnpm eval parity` (D-006). */
const fixture = JSON.parse(
  readFileSync(join(findRepoRoot(), 'eval', 'parity', 'model-parity.json'), 'utf8'),
) as Fixture;

/** Scores one case the way the API does, from the fixture's release. */
function served(c: Fixture['cases'][number]) {
  const { release } = fixture;
  const p = release.parameters;
  const known = new Set(release.knownBooks);
  const sim = new Map(release.neighbours.map(([a, b, s]) => [`${a}:${b}`, s]));
  const readerMean = mean(c.profile.map((r) => r.rating));
  const profileForB2 = c.profile.map((r) => ({
    rating: r.rating,
    embedding: release.books[r.editionId]?.embedding ?? null,
  }));
  return c.targets.map((t) => {
    const book = release.books[t]!;
    const b2 = scoreB2(p, profileForB2, book.embedding);
    const b3 = known.has(t)
      ? scoreB3(p, {
          profile: c.profile
            .filter((r) => known.has(r.editionId))
            .map((r) => ({
              rating: r.rating,
              itemBias: release.itemBias[r.editionId]!,
              similarity: sim.get(`${t}:${r.editionId}`) ?? 0,
            })),
          targetBias: release.itemBias[t]!,
        })
      : null;
    return {
      B0: scoreB0(p, release.itemBias[t]),
      B1: scoreB1(p, c.answers, readerMean, book),
      B2: b2,
      B3: b3,
      B4: b3 === null ? null : scoreB4(p, b2, b3),
    };
  });
}

describe('D-006 parity: TypeScript scores match the Python harness (MODEL-1)', () => {
  it('the fixture has every model and case', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
    expect(fixture.tolerance).toBe(1e-6);
  });

  for (const c of fixture.cases) {
    it(`${c.name}`, () => {
      const scores = served(c);
      for (const model of ['B0', 'B1', 'B2', 'B3', 'B4'] as const) {
        scores.forEach((s, i) => {
          const expected = c.expected[model][i] ?? null;
          if (expected === null) {
            expect(s[model]).toBeNull();
          } else {
            expect(s[model]).not.toBeNull();
            expect(Math.abs(s[model]! - expected)).toBeLessThanOrEqual(fixture.tolerance);
          }
        });
      }
    });
  }

  it('MODEL-1: the same inputs give the same scores', () => {
    for (const c of fixture.cases) expect(served(c)).toEqual(served(c));
  });
});
