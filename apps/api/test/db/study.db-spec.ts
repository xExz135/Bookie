import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { studySchema } from '../../src/study/study.schemas';
import { loadRelease } from '../../src/taste-models/release-loader';
import { type ReleaseParameters, scoreB0, scoreB3 } from '../../src/taste-models/scoring';
import { insertBook } from './analysis-helpers';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/**
 * FE-10's API: the user study of spec 9 (D-027, CONTRACT 4.6), end to end
 * against the real database. A synthetic release is loaded without shipping
 * it and the app is pinned to it, so other test files still see no model.
 */

const VERSION = `2026-10-22.${randomBytes(4).toString('hex')}`;
const PARAMS: ReleaseParameters = {
  B0: { globalMean: 3.9 },
  B1: {
    weightGenre: 0.25,
    weightPace: 0.25,
    weightThemeAvoid: 0.25,
    genreShare: 0.2,
    genreNames: [],
    sensitivityWeights: { high: 1, moderate: 0.5, low: 0.25 },
    themeMap: {},
  },
  B2: { intercept: 0.85, readerMean: 0.78, cosine: 3 },
  B3: { globalMean: 3.9, readerShrinkage: 10, neighbours: 30, weightDamping: 0.5 },
  B4: { intercept: 0.15, b2: 0.1, b3: 0.95 },
};
const metric = { value: 0.35, low: 0.34, high: 0.36, readers: 100 };
const metrics = {
  validation: { spearman: metric, ndcg: metric, mae: metric },
  test: { spearman: metric, ndcg: metric, mae: metric },
};

function writeRelease(
  known: string[],
  bias: Map<string, number>,
  sims: Array<[string, string, number]>,
) {
  const folder = mkdtempSync(join(tmpdir(), 'bookie-study-release-'));
  const items =
    ['edition_id,item_bias', ...known.map((e) => `${e},${bias.get(e)}`)].join('\n') + '\n';
  const pairs =
    ['edition_id,neighbour_id,similarity', ...sims.map((s) => s.join(','))].join('\n') + '\n';
  writeFileSync(join(folder, 'item_bias.csv'), items);
  writeFileSync(join(folder, 'neighbours.csv'), pairs);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const models = Object.fromEntries(
    (['B0', 'B1', 'B2', 'B3', 'B4'] as const).map((m) => [
      m,
      {
        parameters: m === 'B2' ? { ...PARAMS.B2, embeddingModel: 'test-embedding' } : PARAMS[m],
        metrics,
      },
    ]),
  );
  writeFileSync(
    join(folder, 'release.json'),
    JSON.stringify({
      version: VERSION,
      shipped: 'B3',
      selection: 'mean per-reader Spearman on validation',
      seed: 1,
      snapshotChecksum: 'synthetic',
      harnessChecksum: 'synthetic',
      books: known.length,
      neighbourPairs: sims.length,
      models,
      files: { 'item_bias.csv': sha(items), 'neighbours.csv': sha(pairs) },
    }),
  );
  return folder;
}

describe('user study (FE-10, spec 9)', () => {
  let app: NestExpressApplication;
  let db: Client;
  const http = () => request(app.getHttpServer());

  // 14 books the release knows and 4 it does not.
  const known: string[] = [];
  const unknown: string[] = [];
  const bias = new Map<string, number>();
  const sims: Array<[string, string, number]> = [];
  const RATINGS = [5, 4, 2, 4, 3, 5, 1, 4, 3, 2, 5, 4, 3, 4];

  async function reader(label: string): Promise<{ token: string; id: string }> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(label), password: 'study password', displayName: label })
      .expect(201);
    return { token: res.body.accessToken as string, id: res.body.user.id as string };
  }
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function rate(token: string, books: string[], ratings: number[]) {
    for (let i = 0; i < books.length; i++) {
      await http()
        .put(`/api/v1/ratings/${books[i]}`)
        .set(as(token))
        .send({ rating: ratings[i % ratings.length] })
        .expect(200);
    }
  }

  async function study(token: string) {
    const res = await http().get('/api/v1/study').set(as(token)).expect(200);
    const parsed = studySchema.safeParse(res.body);
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    return parsed.data;
  }

  const join = (token: string, body: object = { consent: true }) =>
    http().post('/api/v1/study').set(as(token)).send(body);

  /** The reader with every known book and every unknown one rated: 18 books. */
  async function eligibleReader(label: string) {
    const r = await reader(label);
    await rate(r.token, [...known, ...unknown], RATINGS);
    return r;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp({
      RATING_SAVES_PER_MINUTE: '1000',
      TASTE_MODEL_VERSION: VERSION,
      STUDY_MIN_RATED_BOOKS: '15',
      STUDY_HELD_OUT_BOOKS: '5',
    }));
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    for (let i = 0; i < 14; i++) known.push(await insertBook(db, { reviews: 0 }));
    for (let i = 0; i < 4; i++) unknown.push(await insertBook(db, { reviews: 0 }));
    known.forEach((e, i) => bias.set(e, Math.round((((i * 37) % 11) - 5) * 0.06 * 1000) / 1000));
    for (let i = 0; i < known.length; i++) {
      for (let j = i + 1; j < known.length; j++) {
        if ((i + j) % 3 === 0) continue; // not every pair are neighbours
        const s = Math.round((0.05 + ((i * 13 + j * 7) % 9) * 0.04) * 1e6) / 1e6;
        sims.push([known[i]!, known[j]!, s], [known[j]!, known[i]!, s]);
      }
    }
    const report = await loadRelease(db, writeRelease(known, bias, sims), { ship: false });
    expect(report).toMatchObject({ version: VERSION, madeShipped: false });
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  it('spec 9: a reader with too few rated books sees what is needed and cannot join', async () => {
    const r = await reader('few');
    await rate(r.token, known.slice(0, 8), RATINGS);
    expect(await study(r.token)).toMatchObject({
      status: 'not_eligible',
      ineligibleReason: 'too_few_ratings',
      requirements: { minRatedBooks: 15, heldOutBooks: 5 },
      ratedCount: 8,
      knownCount: 8,
      heldOut: [],
    });
    const refused = await join(r.token).expect(409);
    expect(refused.body.code).toBe('CONFLICT');
  });

  it('needs enough rated books that the learned model knows, to hold them out', async () => {
    const r = await reader('unknown-books');
    const others = [];
    for (let i = 0; i < 12; i++) others.push(await insertBook(db, { reviews: 0 }));
    await rate(r.token, [...known.slice(0, 3), ...unknown, ...others], RATINGS);
    expect(await study(r.token)).toMatchObject({
      status: 'not_eligible',
      ineligibleReason: 'too_few_known_books',
      ratedCount: 19,
      knownCount: 3,
    });
    await join(r.token).expect(409);
  });

  it('needs consent to join', async () => {
    const r = await eligibleReader('no-consent');
    expect((await study(r.token)).status).toBe('eligible');
    const res = await join(r.token, {}).expect(400);
    expect(res.body.fields).toEqual({ consent: 'Agree to take part to join the study.' });
    await join(r.token, { consent: false }).expect(400);
    expect((await study(r.token)).status).toBe('eligible');
  });

  it('spec 9: holds out five known books and predicts each from the other ratings only, next to B0', async () => {
    const r = await eligibleReader('joins');
    const res = await join(r.token).expect(201);
    const s = studySchema.parse(res.body);
    expect(s).toMatchObject({ status: 'joined', modelVersion: VERSION, ratedCount: 18 });
    expect(s.heldOut).toHaveLength(5);

    const ratingOf = new Map([...known, ...unknown].map((e, i) => [e, RATINGS[i % 14]!]));
    const heldIds = s.heldOut.map((h) => h.edition.editionId);
    expect(new Set(heldIds).size).toBe(5);
    for (const h of s.heldOut) {
      const target = h.edition.editionId;
      // Held out only among books the model knows; the reader's own rating is shown.
      expect(known).toContain(target);
      expect(h.yourRating).toBe(ratingOf.get(target));
      // The prediction uses the 13 other rated books the model knows, never the held-out five.
      const profile = known.filter((e) => !heldIds.includes(e));
      const expected = scoreB3(PARAMS, {
        profile: profile.map((e) => ({
          rating: ratingOf.get(e)!,
          itemBias: bias.get(e)!,
          similarity: sims.find(([a, b]) => a === target && b === e)?.[2] ?? 0,
        })),
        targetBias: bias.get(target)!,
      });
      expect(h.prediction).toEqual({
        score: Math.round(expected * 100) / 100,
        modelId: 'B3',
        // 9 of the remaining books are known to the model, below the 10 for medium (D-024).
        confidence: 'low',
      });
      expect(h.baseline).toEqual({
        score: Math.round(scoreB0(PARAMS, bias.get(target)) * 100) / 100,
        modelId: 'B0',
      });
    }

    // The choice is the participant's seeded shuffle, reproducible from the stored rows.
    const row = await db.query(`SELECT id FROM study_participants WHERE user_id = $1`, [r.id]);
    const key = (e: string) => createHash('sha256').update(`${row.rows[0].id}:${e}`).digest('hex');
    expect([...heldIds].sort()).toEqual(
      [...known]
        .sort((a, b) => key(a).localeCompare(key(b)))
        .slice(0, 5)
        .sort(),
    );

    // Joining again changes nothing; neither does rating more books afterwards.
    expect((await join(r.token).expect(200)).body).toEqual(res.body);
    await http().put(`/api/v1/ratings/${heldIds[0]}`).set(as(r.token)).send({ rating: 1 });
    const later = await study(r.token);
    expect(later.heldOut).toEqual(s.heldOut);
  });

  it('SEC-1: a reader sees only their own participation', async () => {
    const owner = await eligibleReader('owner');
    await join(owner.token).expect(201);
    const other = await reader('other');
    expect(await study(other.token)).toMatchObject({ status: 'not_eligible', heldOut: [] });
  });

  it('leaving deletes the participation; the reader can join again', async () => {
    const r = await eligibleReader('leaves');
    await join(r.token).expect(201);
    await http().delete('/api/v1/study').set(as(r.token)).expect(204);
    expect((await study(r.token)).status).toBe('eligible');
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM study_predictions p
         JOIN study_participants s ON s.id = p.participant_id WHERE s.user_id = $1`,
      [r.id],
    );
    expect(rows.rows[0].n).toBe(0);
    await http().delete('/api/v1/study').set(as(r.token)).expect(204);
    await join(r.token).expect(201);
  });

  it('SEC-3: delete my data removes the participation', async () => {
    const r = await eligibleReader('deletes');
    await join(r.token).expect(201);
    await http()
      .delete('/api/v1/me/data')
      .set(as(r.token))
      .send({ password: 'study password' })
      .expect(204);
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM study_participants WHERE user_id = $1`,
      [r.id],
    );
    expect(rows.rows[0].n).toBe(0);
    expect(await study(r.token)).toMatchObject({ status: 'not_eligible', ratedCount: 0 });
  });

  it('without a loaded model nobody can join', async () => {
    const { app: bare } = await createTestApp({ RATING_SAVES_PER_MINUTE: '1000' });
    try {
      const res = await request(bare.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('bare'), password: 'study password', displayName: 'bare' })
        .expect(201);
      const token = res.body.accessToken as string;
      const got = await request(bare.getHttpServer()).get('/api/v1/study').set(as(token));
      expect(got.body).toMatchObject({ status: 'not_eligible', ineligibleReason: 'no_model' });
      await request(bare.getHttpServer())
        .post('/api/v1/study')
        .set(as(token))
        .send({ consent: true })
        .expect(409);
    } finally {
      await bare.close();
    }
  });
});
