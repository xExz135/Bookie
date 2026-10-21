import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { ANALYSIS_LLM } from '../../src/analysis/analysis-pipeline';
import { AnalysisRunner } from '../../src/analysis/analysis-runner';
import { analysisSchema } from '../../src/analysis/analysis.schemas';
import { RATING_SOURCES } from '../../src/sources/sources.tokens';
import { loadRelease } from '../../src/taste-models/release-loader';
import {
  type ReleaseParameters,
  clip,
  scoreB0,
  scoreB2,
  scoreB3,
} from '../../src/taste-models/scoring';
import { FakeLlm, FakeSource, TRAITS, insertBook } from './analysis-helpers';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-13: the taste models served end to end (D-006, D-024). A synthetic
 * release is loaded without shipping it and the API is pinned to it
 * (TASTE_MODEL_VERSION), so other test files still see no model.
 */

const VERSION = `2026-10-21.${randomBytes(4).toString('hex')}`;
const EMBEDDING_MODEL = 'test-embedding:768:text-v1';
const PARAMS: ReleaseParameters = {
  B0: { globalMean: 3.9 },
  B1: {
    weightGenre: 0.25,
    weightPace: 0.25,
    weightThemeAvoid: 0.25,
    genreShare: 0.2,
    genreNames: [],
    sensitivityWeights: { high: 1, moderate: 0.5, low: 0.25 },
    themeMap: { 'Graphic violence and physical harm': 'violence' },
  },
  B2: { intercept: 0.85, readerMean: 0.78, cosine: 3 },
  B3: { globalMean: 3.9, readerShrinkage: 10, neighbours: 30, weightDamping: 0.5 },
  B4: { intercept: 0.15, b2: 0.1, b3: 0.95 },
};

/** A unit vector of 768 numbers that differs per seed. */
function vector(seed: number): number[] {
  const v = Array.from(
    { length: 768 },
    (_, i) => Math.sin(seed * 1.7 + i * 0.37) + (i % (seed + 2)) * 0.01,
  );
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const metrics = {
  validation: {
    spearman: { value: 0.35, low: 0.34, high: 0.36, readers: 100 },
    ndcg: { value: 0.9, low: 0.89, high: 0.91, readers: 100 },
    mae: { value: 0.7, low: 0.69, high: 0.71, readers: 100 },
  },
  test: {
    spearman: { value: 0.34, low: 0.33, high: 0.35, readers: 100 },
    ndcg: { value: 0.9, low: 0.89, high: 0.91, readers: 100 },
    mae: { value: 0.71, low: 0.7, high: 0.72, readers: 100 },
  },
};

function writeRelease(
  known: string[],
  bias: Map<string, number>,
  sims: Array<[string, string, number]>,
  options: { tamper?: boolean; version?: string } = {},
): string {
  const folder = mkdtempSync(join(tmpdir(), 'bookie-release-'));
  const items =
    ['edition_id,item_bias', ...known.map((e) => `${e},${bias.get(e)}`)].join('\n') + '\n';
  const pairs =
    ['edition_id,neighbour_id,similarity', ...sims.map((s) => s.join(','))].join('\n') + '\n';
  writeFileSync(join(folder, 'item_bias.csv'), items);
  writeFileSync(join(folder, 'neighbours.csv'), options.tamper ? pairs + 'x' : pairs);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const release = {
    version: options.version ?? VERSION,
    shipped: 'B3',
    selection: 'mean per-reader Spearman on validation',
    seed: 1,
    snapshotChecksum: 'synthetic',
    harnessChecksum: 'synthetic',
    books: known.length,
    neighbourPairs: sims.length,
    models: {
      B0: { parameters: PARAMS.B0, metrics },
      B1: { parameters: PARAMS.B1, metrics },
      B2: { parameters: { ...PARAMS.B2, embeddingModel: EMBEDDING_MODEL }, metrics },
      B3: { parameters: PARAMS.B3, metrics },
      B4: { parameters: PARAMS.B4, metrics },
    },
    files: { 'item_bias.csv': sha(items), 'neighbours.csv': sha(pairs) },
  };
  writeFileSync(join(folder, 'release.json'), JSON.stringify(release));
  return folder;
}

describe('taste models served (BE-13)', () => {
  let app: NestExpressApplication;
  let db: Client;
  let runner: AnalysisRunner;
  const llm = new FakeLlm();
  const http = () => request(app.getHttpServer());

  // 14 profile books and one target the release knows; two targets it does not.
  const profileBooks: string[] = [];
  let knownTarget = '';
  let conflictTarget = '';
  let outsideWithEmbedding = '';
  let outsideWithout = '';
  const bias = new Map<string, number>();
  const sims: Array<[string, string, number]> = [];
  const embeddings = new Map<string, number[]>();

  async function reader(label: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(label), password: 'taste password', displayName: label })
      .expect(201);
    return res.body.accessToken as string;
  }

  async function rate(token: string, ratings: number[]) {
    for (let i = 0; i < ratings.length; i++) {
      await http()
        .put(`/api/v1/ratings/${profileBooks[i]}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: ratings[i] })
        .expect(200);
    }
  }

  async function analyse(token: string, editionId: string) {
    const res = await http()
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .send({ editionId })
      .expect(201);
    await runner.idle();
    const got = await http()
      .get(`/api/v1/analyses/${res.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const parsed = analysisSchema.safeParse(got.body);
    if (!parsed.success)
      throw new Error(
        `Not a valid Analysis: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return got.body as ReturnType<typeof analysisSchema.parse>;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {
        ANALYSIS_RECOVER_ON_START: 'false',
        RATE_LIMIT_ANALYSES_PER_HOUR: '1000',
        RATING_SAVES_PER_MINUTE: '1000',
        TASTE_MODEL_VERSION: VERSION,
      },
      [
        { token: ANALYSIS_LLM, value: llm },
        { token: RATING_SOURCES, value: [new FakeSource('open_library', 4.1, 500)] },
      ],
    ));
    runner = app.get(AnalysisRunner);
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();

    for (let i = 0; i < 14; i++) profileBooks.push(await insertBook(db, { reviews: 0 }));
    knownTarget = await insertBook(db);
    conflictTarget = await insertBook(db);
    outsideWithEmbedding = await insertBook(db);
    outsideWithout = await insertBook(db);
    const known = [...profileBooks, knownTarget, conflictTarget];
    known.forEach((e, i) => bias.set(e, Math.round((((i * 37) % 11) - 5) * 0.06 * 1000) / 1000));
    profileBooks.forEach((p, i) => {
      if (i % 3 === 2) return; // some rated books are not neighbours of the target
      for (const t of [knownTarget, conflictTarget]) {
        const s = Math.round((0.05 + ((i * 13) % 7) * 0.03) * 1e6) / 1e6;
        sims.push([t, p, s], [p, t, s]);
      }
    });
    [...known, outsideWithEmbedding].forEach((e, i) => embeddings.set(e, vector(i + 1)));
    for (const [e, v] of embeddings) {
      await db.query(
        `INSERT INTO book_embeddings (edition_id, embedding_model, embedding) VALUES ($1, $2, $3::vector)`,
        [e, EMBEDDING_MODEL, JSON.stringify(v)],
      );
    }
    const report = await loadRelease(db, writeRelease(known, bias, sims), { ship: false });
    expect(report).toMatchObject({ version: VERSION, alreadyLoaded: false, madeShipped: false });
  });

  beforeEach(() => {
    llm.traitsReply = null;
  });

  afterAll(async () => {
    await runner.idle();
    await db.end();
    await app.close();
  });

  const expectedB3 = (ratings: number[], target: string) =>
    scoreB3(PARAMS, {
      profile: ratings.map((r, i) => ({
        rating: r,
        itemBias: bias.get(profileBooks[i]!)!,
        similarity: sims.find(([a, b]) => a === target && b === profileBooks[i])?.[2] ?? 0,
      })),
      targetBias: bias.get(target)!,
    });

  it('spec 7 cold start: below the minimum, a reader without answers gets B0, labeled, with low confidence', async () => {
    const token = await reader('cold-b0');
    await rate(token, [5, 4, 2, 4, 3]);
    const a = await analyse(token, knownTarget);
    expect(a.status).toBe('complete');
    expect(a.personalMatch).toMatchObject({
      status: 'done',
      modelId: 'B0',
      modelVersion: VERSION,
      isFallback: true,
      evidenceConfidence: { level: 'low' },
      similarRatedBooks: [],
    });
    expect(a.personalMatch.score).toBe(
      Math.round(scoreB0(PARAMS, bias.get(knownTarget)) * 10) / 10,
    );
    expect(a.personalMatch.evidenceConfidence!.reasons).toEqual([
      '5 rated books; 10 are needed for a confident match',
      'Scored by the global average rating (B0), not the learned model',
    ]);
  });

  it('spec 7 cold start: a reader who answered the questionnaire gets B1; unknown answers add nothing (MODEL-2)', async () => {
    const token = await reader('cold-b1');
    await rate(token, [5, 4, 4, 4, 3]);
    await http()
      .put('/api/v1/questionnaire')
      .set('Authorization', `Bearer ${token}`)
      .send({ pace: 'fast', likedGenres: null, dislikedGenres: null, themesToAvoid: null })
      .expect(200);
    const a = await analyse(token, knownTarget);
    // Mean 4.0; the book is fast (the fake traits) and the reader likes fast; nothing else is known.
    expect(a.personalMatch).toMatchObject({ modelId: 'B1', isFallback: true, score: 4.3 });
    expect(a.personalMatch.traits).toContainEqual(
      expect.objectContaining({
        trait: 'pace',
        fit: 'aligned',
        bookValues: ['fast'],
        yourValues: ['fast'],
      }),
    );
  });

  it('serves the shipped model with its version, confidence and explanations (MODEL-3)', async () => {
    const token = await reader('shipped');
    const ratings = [5, 4, 2, 4, 3, 5, 1, 4, 3, 5, 2, 4];
    await rate(token, ratings);
    const a = await analyse(token, knownTarget);
    expect(a.personalMatch).toMatchObject({
      status: 'done',
      modelId: 'B3',
      modelVersion: VERSION,
      isFallback: false,
      ratedCount: 12,
      evidenceConfidence: { level: 'medium', reasons: ['12 rated books'] },
    });
    expect(a.personalMatch.score).toBe(Math.round(expectedB3(ratings, knownTarget) * 10) / 10);

    // The three most similar rated books, by the model's own similarity.
    const top = profileBooks
      .map((p, i) => ({ p, i, s: sims.find(([t, b]) => t === knownTarget && b === p)?.[2] ?? 0 }))
      .filter((x) => x.s > 0 && x.i < ratings.length)
      .sort((x, y) => y.s - x.s || x.p.localeCompare(y.p))
      .slice(0, 3);
    expect(a.personalMatch.similarRatedBooks.map((b) => [b.editionId, b.yourRating])).toEqual(
      top.map((x) => [x.p, ratings[x.i]]),
    );
    // No answers on record: every trait is "not factored in", with the book's evidence.
    expect(
      a.personalMatch.traits.every((t) => t.fit === 'unknown' && t.yourValues.length === 0),
    ).toBe(true);
    const pace = a.personalMatch.traits.find((t) => t.trait === 'pace')!;
    expect(pace.bookValues).toEqual([TRAITS.pace.value]);
    const evidence = new Set(a.publicReception.evidence.map((e) => e.id));
    expect(pace.evidenceIds.length).toBeGreaterThan(0);
    expect(pace.evidenceIds.every((id) => evidence.has(id))).toBe(true);

    // MODEL-3: the stored row names the model version, profile version and time.
    const stored = await db.query(
      `SELECT p.score::float AS score, p.generated_at, p.taste_profile_version_id, m.version, m.model_id
         FROM personal_analyses p JOIN model_versions m ON m.id = p.model_version_id WHERE p.analysis_id = $1`,
      [a.id],
    );
    expect(stored.rows[0]).toMatchObject({ version: VERSION, model_id: 'B3' });
    expect(stored.rows[0].taste_profile_version_id).not.toBeNull();
    expect(stored.rows[0].generated_at).toBeInstanceOf(Date);

    // MODEL-1: the same profile and model version give the same score.
    const again = await analyse(token, knownTarget);
    expect(again.id).not.toBe(a.id);
    expect(again.personalMatch.score).toBe(a.personalMatch.score);

    // LIST-2: a medium-confidence score from the learned model is ranked on the reading list.
    await http()
      .post('/api/v1/reading-list')
      .set('Authorization', `Bearer ${token}`)
      .send({ editionId: knownTarget })
      .expect(201);
    const list = await http()
      .get('/api/v1/reading-list')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ group: 'ranked', personalMatch: { modelId: 'B3' } });
  });

  it('a questionnaire answer the book conflicts with is shown as a thing to keep in mind', async () => {
    const token = await reader('conflict');
    await rate(token, [5, 4, 2, 4, 3, 5, 1, 4, 3, 5]);
    await http()
      .put('/api/v1/questionnaire')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pace: 'slow',
        themesToAvoid: [{ theme: 'Graphic violence and physical harm', sensitivity: 'high' }],
      })
      .expect(200);
    llm.traitsReply = {
      ...TRAITS,
      themes: [
        { value: 'violence', evidence: [2] },
        { value: 'survival', evidence: [1] },
      ],
    };
    const a = await analyse(token, conflictTarget);
    expect(a.personalMatch.modelId).toBe('B3');
    const fit = (trait: string, f: string) =>
      a.personalMatch.traits.find((t) => t.trait === trait && t.fit === f);
    expect(fit('pace', 'conflicting')).toMatchObject({
      bookValues: ['fast'],
      yourValues: ['slow'],
    });
    expect(fit('themes', 'conflicting')).toMatchObject({
      bookValues: ['violence'],
      yourValues: ['violence'],
    });
    // The learned model's score does not use the questionnaire.
    expect(a.personalMatch.score).toBe(
      Math.round(expectedB3([5, 4, 2, 4, 3, 5, 1, 4, 3, 5], conflictTarget) * 10) / 10,
    );
  });

  it('a book outside the release gets B2 from embeddings, with low confidence and the reason', async () => {
    const token = await reader('outside-b2');
    const ratings = [5, 4, 2, 4, 3, 5, 1, 4, 3, 5, 2];
    await rate(token, ratings);
    const a = await analyse(token, outsideWithEmbedding);
    expect(a.personalMatch).toMatchObject({
      modelId: 'B2',
      isFallback: false,
      evidenceConfidence: { level: 'low' },
    });
    expect(a.personalMatch.evidenceConfidence!.reasons[1]).toMatch(
      /not among the 16 books the learned model knows/,
    );
    const expected = scoreB2(
      PARAMS,
      ratings.map((r, i) => ({ rating: r, embedding: embeddings.get(profileBooks[i]!)! })),
      embeddings.get(outsideWithEmbedding)!,
    );
    expect(a.personalMatch.score).toBe(Math.round(expected * 10) / 10);
    expect(a.personalMatch.similarRatedBooks.length).toBeGreaterThan(0);
  });

  it('a book outside the release without an embedding falls back to B0 at the global mean', async () => {
    const token = await reader('outside-b0');
    await rate(token, [5, 4, 2, 4, 3, 5, 1, 4, 3, 5]);
    const a = await analyse(token, outsideWithout);
    expect(a.personalMatch).toMatchObject({ modelId: 'B0', isFallback: true, score: clip(3.9) });
    expect(a.personalMatch.evidenceConfidence!.reasons[0]).toMatch(/not among the 16 books/);
  });

  it('the loader refuses a changed file, a book missing from the catalog, and loads a version only once', async () => {
    const known = [...profileBooks, knownTarget, conflictTarget];
    await expect(
      loadRelease(
        db,
        writeRelease(known, bias, sims, { tamper: true, version: '2026-10-21.0badf11e' }),
        { ship: false },
      ),
    ).rejects.toThrow(/checksum/);
    const missing = '00000000-0000-4000-8000-00000000dead';
    const withMissing = new Map(bias).set(missing, 0.1);
    await expect(
      loadRelease(
        db,
        writeRelease([...known, missing], withMissing, sims, { version: '2026-10-21.0badf11f' }),
        {
          ship: false,
        },
      ),
    ).rejects.toThrow(/not in the catalog/);
    const again = await loadRelease(db, writeRelease(known, bias, sims), { ship: false });
    expect(again.alreadyLoaded).toBe(true);
    const rows = await db.query(
      'SELECT count(*)::int AS n FROM model_versions WHERE version = $1',
      [VERSION],
    );
    expect(rows.rows[0].n).toBe(5);
    const failed = await db.query(
      `SELECT count(*)::int AS n FROM model_versions WHERE version IN ('2026-10-21.0badf11e', '2026-10-21.0badf11f')`,
    );
    expect(failed.rows[0].n).toBe(0);
  });
});
