import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { ANALYSIS_LLM } from '../../src/analysis/analysis-pipeline';
import { AnalysisRunner } from '../../src/analysis/analysis-runner';
import { analysisSchema } from '../../src/analysis/analysis.schemas';
import { comparisonSchema, readingListSchema } from '../../src/reader-data/reader-data.schemas';
import { RATING_SOURCES } from '../../src/sources/sources.tokens';
import { FakeLlm, FakeSource, insertBook, TRAITS } from './analysis-helpers';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-10: feedback, reading list, compare and delete-my-data (CONTRACT 4.5),
 * against the real database and Redis. Analyses run through the real
 * pipeline with a fake model and fake live sources. Until the taste models
 * exist (BE-13), a scored personal match is stored the way BE-13 will store
 * it, so ranking and personal feedback can be tested now.
 */

const PASSWORD = 'reader data password';
/** Rows kept by delete-my-data on purpose (D-022). */
const KEPT_TABLES = [
  'users',
  'refresh_tokens',
  'password_reset_tokens',
  'scan_usages',
  'refresh_requests',
];

describe('reader data (BE-10)', () => {
  let app: NestExpressApplication;
  let db: Client;
  let runner: AnalysisRunner;
  const llm = new FakeLlm();
  const http = () => request(app.getHttpServer());

  async function reader(label: string): Promise<{ token: string; id: string }> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(label), password: PASSWORD, displayName: label })
      .expect(201);
    return { token: res.body.accessToken as string, id: res.body.user.id as string };
  }

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const book = () => insertBook(db);

  async function rateBooks(token: string, count: number) {
    for (let i = 0; i < count; i++) {
      await http()
        .put(`/api/v1/ratings/${await insertBook(db, { reviews: 0 })}`)
        .set(as(token))
        .send({ rating: 4 })
        .expect(200);
    }
  }

  /** Runs an analysis to the end and returns its id. */
  async function analysed(token: string, editionId: string): Promise<string> {
    const res = await http().post('/api/v1/analyses').set(as(token)).send({ editionId });
    expect([200, 201]).toContain(res.status);
    await runner.idle();
    return res.body.id as string;
  }

  /** Stores a scored personal match on a finished analysis, as BE-13 will. */
  async function scoreAs(
    analysisId: string,
    score: number,
    confidence: 'low' | 'medium' | 'high',
    modelId: 'B0' | 'B1' | 'B4' = 'B4',
  ) {
    const model = await db.query<{ id: string }>(
      `INSERT INTO model_versions (id, model_id, version) VALUES ($1, $2, 'be10-test')
       ON CONFLICT (model_id, version) DO UPDATE SET version = EXCLUDED.version RETURNING id`,
      [randomUUID(), modelId],
    );
    await db.query(`DELETE FROM personal_analyses WHERE analysis_id = $1`, [analysisId]);
    await db.query(
      `INSERT INTO personal_analyses (id, analysis_id, user_id, edition_id, taste_profile_version_id,
         public_analysis_id, model_version_id, outcome, score, confidence, confidence_reasons)
       SELECT $1, a.id, a.user_id, a.edition_id, a.taste_profile_version_id, a.public_analysis_id, $2,
              'scored', $3, $4, ARRAY['test reason']
       FROM analyses a WHERE a.id = $5`,
      [randomUUID(), model.rows[0]!.id, score, confidence, analysisId],
    );
    await db.query(
      `UPDATE analysis_steps SET status = 'done', error_code = NULL WHERE analysis_id = $1 AND step = 'personalMatch'`,
      [analysisId],
    );
    await db.query(`UPDATE analyses SET status = 'complete' WHERE id = $1`, [analysisId]);
  }

  const feedback = (token: string, body: object) =>
    http().put('/api/v1/feedback').set(as(token)).send(body);
  const list = async (token: string) => {
    const res = await http().get('/api/v1/reading-list').set(as(token)).expect(200);
    readingListSchema.parse(res.body);
    return res.body as ReturnType<typeof readingListSchema.parse>;
  };
  const addToList = (token: string, editionId: string) =>
    http().post('/api/v1/reading-list').set(as(token)).send({ editionId });

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {
        ANALYSIS_RECOVER_ON_START: 'false',
        RATE_LIMIT_ANALYSES_PER_HOUR: '1000',
        RATING_SAVES_PER_MINUTE: '1000',
        RATE_LIMIT_DELETE_DATA_PER_HOUR: '3',
      },
      [
        { token: ANALYSIS_LLM, value: llm },
        {
          token: RATING_SOURCES,
          value: [new FakeSource('open_library', 4.1, 500), new FakeSource('hardcover', 4.0, 900)],
        },
      ],
    ));
    runner = app.get(AnalysisRunner);
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
  });

  beforeEach(() => {
    llm.traits = 'ok';
    llm.summary = 'ok';
    llm.gate = null;
    llm.traitsReply = null;
  });

  afterAll(async () => {
    await runner.idle();
    await db.end();
    await app.close();
  });

  describe('feedback', () => {
    it('FB-1: saved against the analysis with its versions, changeable, one value per section', async () => {
      const { token, id: userId } = await reader('fb1');
      await rateBooks(token, 3);
      const analysisId = await analysed(token, await book());
      await scoreAs(analysisId, 4.2, 'medium');

      const first = await feedback(token, {
        analysisId,
        target: 'public',
        value: 'accurate',
      }).expect(200);
      expect(first.body).toEqual({
        target: 'public',
        value: 'accurate',
        updatedAt: expect.any(String),
      });
      await feedback(token, { analysisId, target: 'public', value: 'not_for_me' }).expect(200);
      await feedback(token, { analysisId, target: 'personal', value: 'accurate' }).expect(200);

      const rows = await db.query(
        `SELECT f.target, f.value, f.taste_profile_version_id = a.taste_profile_version_id AS same_version,
                f.model_version_id = pa.model_version_id AS same_model, f.model_version_id IS NULL AS no_model
         FROM feedback f JOIN analyses a ON a.id = f.analysis_id
         LEFT JOIN personal_analyses pa ON pa.analysis_id = a.id
         WHERE f.user_id = $1 ORDER BY f.target::text`,
        [userId],
      );
      expect(rows.rows).toEqual([
        {
          target: 'personal',
          value: 'accurate',
          same_version: true,
          same_model: true,
          no_model: false,
        },
        {
          target: 'public',
          value: 'not_for_me',
          same_version: true,
          same_model: null,
          no_model: true,
        },
      ]);
      const view = await http().get(`/api/v1/analyses/${analysisId}`).set(as(token)).expect(200);
      expect(view.body.feedback).toEqual({ public: 'not_for_me', personal: 'accurate' });
    });

    it('FB-1: refused on a section that failed or was not generated', async () => {
      const { token } = await reader('fb-none');
      const noTaste = await analysed(token, await book());
      await feedback(token, { analysisId: noTaste, target: 'personal', value: 'accurate' }).expect(
        409,
      );

      llm.traits = 'invalid';
      const failed = await analysed(token, await book());
      const res = await feedback(token, {
        analysisId: failed,
        target: 'public',
        value: 'accurate',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      const stored = await db.query(
        `SELECT count(*)::int AS n FROM feedback WHERE analysis_id = ANY($1)`,
        [[noTaste, failed]],
      );
      expect(stored.rows[0].n).toBe(0);
    });

    it("FB-2: one reader cannot give feedback on another reader's analysis", async () => {
      const owner = await reader('fb2-owner');
      const other = await reader('fb2-other');
      const analysisId = await analysed(owner.token, await book());
      const res = await feedback(other.token, {
        analysisId,
        target: 'public',
        value: 'not_for_me',
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      await feedback(other.token, {
        analysisId: 'nope',
        target: 'public',
        value: 'accurate',
      }).expect(400);
      await feedback(owner.token, { analysisId, target: 'public', value: 'maybe' }).expect(400);
      const stored = await db.query(
        `SELECT count(*)::int AS n FROM feedback WHERE analysis_id = $1`,
        [analysisId],
      );
      expect(stored.rows[0].n).toBe(0);
    });
  });

  describe('reading list', () => {
    it('LIST-1, LIST-2: confident matches ranked by stored score; low confidence and no match labeled, newest first', async () => {
      const { token } = await reader('list');
      await rateBooks(token, 3);
      const ids: Record<string, string> = {};
      const analyses: Record<string, string> = {};
      for (const name of [
        'noAnalysis',
        'unavailable',
        'fallback',
        'lowB4',
        'highLow',
        'mediumHigh',
      ]) {
        ids[name] = await book();
        await addToList(token, ids[name]!).expect(201);
      }
      analyses.unavailable = await analysed(token, ids.unavailable!); // MODEL_UNAVAILABLE: no score
      for (const [name, score, confidence, model] of [
        ['fallback', 4.8, 'low', 'B1'],
        ['lowB4', 4.9, 'low', 'B4'],
        ['highLow', 3.1, 'high', 'B4'],
        ['mediumHigh', 4.6, 'medium', 'B4'],
      ] as const) {
        analyses[name] = await analysed(token, ids[name]!);
        await scoreAs(analyses[name]!, score, confidence, model);
      }

      const { items } = await list(token);
      const order = items.map((i) => [i.edition.editionId, i.group]);
      expect(order).toEqual([
        [ids.mediumHigh, 'ranked'],
        [ids.highLow, 'ranked'],
        // Labeled, not ranked by score: newest added first.
        [ids.lowB4, 'low_confidence'],
        [ids.fallback, 'low_confidence'],
        [ids.unavailable, 'no_match'],
        [ids.noAnalysis, 'no_match'],
      ]);
      const top = items[0]!;
      expect(top.analysisId).toBe(analyses.mediumHigh);
      expect(top.personalMatch).toMatchObject({
        status: 'done',
        score: 4.6,
        modelId: 'B4',
        isFallback: false,
      });
      expect(items.find((i) => i.edition.editionId === ids.fallback)!.personalMatch).toMatchObject({
        isFallback: true,
        modelId: 'B1',
      });
      expect(items.find((i) => i.edition.editionId === ids.noAnalysis)).toMatchObject({
        analysisId: null,
        personalMatch: null,
      });
    });

    it('LIST-1: the order changes only when a new analysis finishes, not on a profile edit or a running analysis', async () => {
      const { token } = await reader('list-stable');
      await rateBooks(token, 3);
      const a = await book();
      const b = await book();
      await addToList(token, a).expect(201);
      await addToList(token, b).expect(201);
      await scoreAs(await analysed(token, a), 4.5, 'high');
      const oldB = await analysed(token, b);
      await scoreAs(oldB, 3.0, 'high');
      const before = await list(token);
      expect(before.items.map((i) => i.edition.editionId)).toEqual([a, b]);

      // A profile edit marks results outdated but changes no stored score.
      await rateBooks(token, 1);
      const edited = await list(token);
      expect(edited.items.map((i) => [i.edition.editionId, i.personalMatch!.score])).toEqual([
        [a, 4.5],
        [b, 3.0],
      ]);
      expect(edited.items.every((i) => i.personalMatch!.isOutdated)).toBe(true);

      // A new analysis of b, still running: the list keeps the finished one.
      let release!: () => void;
      llm.gate = new Promise((resolve) => (release = resolve));
      const pending = await http()
        .post(`/api/v1/analyses/${oldB}/recalculate`)
        .set(as(token))
        .expect(201);
      const whileRunning = await list(token);
      expect(whileRunning.items.find((i) => i.edition.editionId === b)!.analysisId).toBe(oldB);
      release();
      await runner.idle();
      await scoreAs(pending.body.id as string, 4.9, 'medium');

      const after = await list(token);
      expect(after.items.map((i) => i.edition.editionId)).toEqual([b, a]);
      expect(after.items[0]!.analysisId).toBe(pending.body.id);
    });

    it('adds once, removes idempotently, and keeps each reader to their own list', async () => {
      const owner = await reader('list-own');
      const other = await reader('list-other');
      const editionId = await book();
      const added = await addToList(owner.token, editionId).expect(201);
      const again = await addToList(owner.token, editionId).expect(200);
      expect(again.body).toEqual(added.body);
      await addToList(owner.token, randomUUID()).expect(404);
      await addToList(owner.token, 'not-an-id').expect(400);

      expect((await list(other.token)).items).toEqual([]);
      // Removing from another reader's list touches nothing of the owner's.
      await http().delete(`/api/v1/reading-list/${editionId}`).set(as(other.token)).expect(204);
      expect((await list(owner.token)).items).toHaveLength(1);

      await http().delete(`/api/v1/reading-list/${editionId}`).set(as(owner.token)).expect(204);
      await http().delete(`/api/v1/reading-list/${editionId}`).set(as(owner.token)).expect(204);
      await http().delete('/api/v1/reading-list/not-an-id').set(as(owner.token)).expect(404);
      expect((await list(owner.token)).items).toEqual([]);
    });
  });

  describe('compare', () => {
    it('shows two of the reader’s analyses side by side with the traits that differ', async () => {
      const { token } = await reader('compare');
      const a = await analysed(token, await book());
      llm.traitsReply = {
        ...TRAITS,
        tone: { value: 'hopeful', evidence: [2] },
        contentIntensity: { value: 'low', evidence: [3] },
      };
      const b = await analysed(token, await book());

      const res = await http().get(`/api/v1/compare?a=${a}&b=${b}`).set(as(token)).expect(200);
      const body = comparisonSchema.parse(res.body);
      expect(body.a.id).toBe(a);
      expect(body.b.id).toBe(b);
      analysisSchema.parse(body.a);
      expect(body.traitDifferences).toEqual([
        { trait: 'tone', a: ['tense'], b: ['hopeful'] },
        { trait: 'contentIntensity', a: [], b: ['low'] },
      ]);
    });

    it('refuses the same analysis twice, bad ids, and another reader’s analysis', async () => {
      const owner = await reader('compare-own');
      const other = await reader('compare-other');
      const a = await analysed(owner.token, await book());
      const b = await analysed(owner.token, await book());
      const same = await http()
        .get(`/api/v1/compare?a=${a}&b=${a}`)
        .set(as(owner.token))
        .expect(400);
      expect(same.body.fields).toEqual({ b: 'Choose two different analyses.' });
      await http().get(`/api/v1/compare?a=${a}`).set(as(owner.token)).expect(400);
      await http().get(`/api/v1/compare?a=${a}&b=${b}`).set(as(other.token)).expect(404);
      const mine = await analysed(other.token, await book());
      await http().get(`/api/v1/compare?a=${mine}&b=${b}`).set(as(other.token)).expect(404);
    });
  });

  describe('delete my data', () => {
    async function rowsReferencing(userId: string): Promise<Record<string, number>> {
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY table_name`,
      );
      const counts: Record<string, number> = {};
      for (const { table_name } of tables.rows) {
        const r = await db.query(
          `SELECT count(*)::int AS n FROM "${table_name}" WHERE user_id = $1`,
          [userId],
        );
        if (r.rows[0].n > 0) counts[table_name] = r.rows[0].n;
      }
      const self = await db.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [userId]);
      if (self.rows[0].n > 0) counts.users = self.rows[0].n;
      return counts;
    }

    it('SEC-3: removes every row referencing the reader except the documented ones, and nothing of anyone else', async () => {
      const me = await reader('delete-me');
      const other = await reader('delete-other');
      await rateBooks(me.token, 3);
      await rateBooks(other.token, 3);
      await http()
        .put('/api/v1/questionnaire')
        .set(as(me.token))
        .send({ pace: 'fast' })
        .expect(200);
      await http()
        .post('/api/v1/ratings/import')
        .set(as(me.token))
        .attach(
          'file',
          Buffer.from('Book Id,Title,Author,My Rating\n1,Some Book,Some Author,4\n'),
          {
            filename: 'goodreads_library_export.csv',
            contentType: 'text/csv',
          },
        )
        .expect(202);
      const editionId = await book();
      const mine = await analysed(me.token, editionId);
      await scoreAs(mine, 4.1, 'medium');
      await feedback(me.token, { analysisId: mine, target: 'personal', value: 'accurate' }).expect(
        200,
      );
      await addToList(me.token, editionId).expect(201);
      const theirs = await analysed(other.token, editionId);
      await feedback(other.token, {
        analysisId: theirs,
        target: 'public',
        value: 'accurate',
      }).expect(200);
      await addToList(other.token, editionId).expect(201);
      await runner.idle();

      const versions = await db.query<{ id: string }>(
        `SELECT id FROM taste_profile_versions WHERE user_id = $1`,
        [me.id],
      );
      const otherBefore = await rowsReferencing(other.id);
      expect(Object.keys(await rowsReferencing(me.id))).toEqual(
        expect.arrayContaining([
          'analyses',
          'feedback',
          'personal_analyses',
          'rating_imports',
          'reading_list_items',
          'taste_profile_versions',
        ]),
      );

      await http()
        .delete('/api/v1/me/data')
        .set(as(me.token))
        .send({ password: PASSWORD })
        .expect(204);

      const left = await rowsReferencing(me.id);
      expect(Object.keys(left).every((t) => KEPT_TABLES.includes(t))).toBe(true);
      // Rows that reach the reader through a deleted parent are gone too.
      const ratings = await db.query(
        `SELECT count(*)::int AS n FROM profile_ratings WHERE taste_profile_version_id = ANY($1::uuid[])`,
        [versions.rows.map((v) => v.id)],
      );
      expect(ratings.rows[0].n).toBe(0);
      const steps = await db.query(
        `SELECT count(*)::int AS n FROM analysis_steps WHERE analysis_id = $1`,
        [mine],
      );
      expect(steps.rows[0].n).toBe(0);
      // Nothing of the other reader changed; the shared public analysis stays.
      expect(await rowsReferencing(other.id)).toEqual(otherBefore);
      await http().get(`/api/v1/analyses/${theirs}`).set(as(other.token)).expect(200);

      // Still signed in, starting again from onboarding.
      const meNow = await http().get('/api/v1/me').set(as(me.token)).expect(200);
      expect(meNow.body.onboardingState).toBe('pending');
      const profile = await http().get('/api/v1/taste-profile').set(as(me.token)).expect(200);
      expect(profile.body).toMatchObject({ version: 0, ratedCount: 0 });
      const history = await http().get('/api/v1/analyses').set(as(me.token)).expect(200);
      expect(history.body.items).toEqual([]);
      expect((await list(me.token)).items).toEqual([]);
    });

    it('SEC-3: asks for the password, deletes nothing when it is wrong, and limits attempts', async () => {
      const me = await reader('delete-guard');
      await rateBooks(me.token, 1);
      const wrong = await http()
        .delete('/api/v1/me/data')
        .set(as(me.token))
        .send({ password: 'not it' })
        .expect(400);
      expect(wrong.body.fields).toEqual({ password: 'That password is not correct.' });
      await http().delete('/api/v1/me/data').set(as(me.token)).send({}).expect(400);
      const still = await http().get('/api/v1/taste-profile').set(as(me.token)).expect(200);
      expect(still.body.ratedCount).toBe(1);

      // The limit is 3 per hour in this app; the empty body never reached it.
      await http()
        .delete('/api/v1/me/data')
        .set(as(me.token))
        .send({ password: 'not it' })
        .expect(400);
      await http()
        .delete('/api/v1/me/data')
        .set(as(me.token))
        .send({ password: 'not it' })
        .expect(400);
      const limited = await http()
        .delete('/api/v1/me/data')
        .set(as(me.token))
        .send({ password: PASSWORD });
      expect(limited.status).toBe(429);
      expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
    });
  });
});
