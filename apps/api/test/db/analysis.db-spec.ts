import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { AnalysisPipeline, ANALYSIS_LLM } from '../../src/analysis/analysis-pipeline';
import { AnalysisRunner } from '../../src/analysis/analysis-runner';
import { analysisListSchema, analysisSchema } from '../../src/analysis/analysis.schemas';
import { RATING_SOURCES } from '../../src/sources/sources.tokens';
import { FakeLlm, FakeSource, insertBook, SUMMARY } from './analysis-helpers';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-8: the analysis pipeline end to end, against the real database and
 * Redis. Live sources and the language model are fakes, so every outcome can
 * be produced on purpose.
 */

describe('analysis pipeline (BE-8)', () => {
  let app: NestExpressApplication;
  let db: Client;
  let runner: AnalysisRunner;
  let pipeline: AnalysisPipeline;
  const llm = new FakeLlm();
  const openLibrary = new FakeSource('open_library', 4.13, 570);
  const hardcover = new FakeSource('hardcover', 4.2, 7991);
  const http = () => request(app.getHttpServer());

  async function reader(label: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(label), password: 'analysis password', displayName: label })
      .expect(201);
    return res.body.accessToken as string;
  }

  const book = (options?: Parameters<typeof insertBook>[1]) => insertBook(db, options);

  const start = (token: string, editionId: string) =>
    http().post('/api/v1/analyses').set('Authorization', `Bearer ${token}`).send({ editionId });
  const get = (token: string, id: string) =>
    http().get(`/api/v1/analyses/${id}`).set('Authorization', `Bearer ${token}`);

  /** Waits for the background work, then reads the analysis and checks it against the contract schema. */
  async function finished(token: string, id: string) {
    await runner.idle();
    const res = await get(token, id).expect(200);
    const parsed = analysisSchema.safeParse(res.body);
    if (!parsed.success)
      throw new Error(
        `Not a valid Analysis: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return res.body as ReturnType<typeof analysisSchema.parse>;
  }

  async function rateBooks(token: string, count: number) {
    for (let i = 0; i < count; i++) {
      const editionId = await book({ reviews: 0 });
      await http()
        .put(`/api/v1/ratings/${editionId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 4 })
        .expect(200);
    }
  }

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {
        ANALYSIS_RECOVER_ON_START: 'false',
        RATE_LIMIT_ANALYSES_PER_HOUR: '1000',
        RATING_SAVES_PER_MINUTE: '1000',
      },
      [
        { token: ANALYSIS_LLM, value: llm },
        { token: RATING_SOURCES, value: [openLibrary, hardcover] },
      ],
    ));
    runner = app.get(AnalysisRunner);
    pipeline = app.get(AnalysisPipeline);
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
  });

  beforeEach(() => {
    llm.traits = 'ok';
    llm.summary = 'ok';
    llm.gate = null;
    openLibrary.mode = 'ok';
    hardcover.mode = 'ok';
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await runner.idle();
    await db.end();
    await app.close();
  });

  it('RES-1, RES-2, RES-5, DISC-5: runs every step in the background and names the edition analysed', async () => {
    const token = await reader('full');
    const editionId = await book({ ratings: 5000 });
    const before = { ...llm.calls };

    const res = await start(token, editionId).expect(201);
    expect(res.body.pollAfterMs).toBeGreaterThan(0);
    expect(res.body.steps.map((s: { name: string }) => s.name)).toEqual([
      'resolve',
      'fetchReviews',
      'selectReviews',
      'extractTraits',
      'publicSummary',
      'evidenceConfidence',
      'personalMatch',
      'finalize',
    ]);
    // RES-1: the client does nothing more; the result still appears.
    const a = await finished(token, res.body.id);

    expect(a.status).toBe('complete');
    expect(a.pollAfterMs).toBeNull();
    expect(a.steps.every((s) => s.status === 'done')).toBe(true);
    expect(a.edition).toMatchObject({
      editionId,
      isbn13: '9780439023481',
      format: 'Hardcover',
      publisher: 'Scholastic Press',
      pageCount: 374,
      author: 'Suzanne Test',
    });

    const pr = a.publicReception;
    expect(pr).toMatchObject({
      status: 'done',
      evidenceState: 'sufficient',
      summary: SUMMARY.summary,
    });
    expect(pr.evidenceConfidence).toEqual({
      level: 'medium',
      reasons: [
        '12 reviews with text from 1 source',
        'Ratings from 3 sources',
        'Praise and complaints both represented',
      ],
    });
    expect(pr.praises).toHaveLength(1);
    expect(pr.complaints[0]!.text).toBe('The ending felt rushed.');
    // RES-5: every cited id is in the response (the schema checks it too), with the review text as an excerpt.
    const cited = new Set(
      [...pr.praises, ...pr.complaints, ...pr.traits].flatMap((c) => c.evidenceIds),
    );
    expect(new Set(pr.evidence.map((e) => e.id))).toEqual(cited);
    expect(
      pr.evidence.every(
        (e) => e.kind === 'review' && e.excerpt && e.source === 'goodreads_dataset',
      ),
    ).toBe(true);
    expect(pr.traits).toEqual([
      { trait: 'pace', values: ['fast'], evidenceIds: expect.any(Array) },
      { trait: 'tone', values: ['tense'], evidenceIds: expect.any(Array) },
      { trait: 'themes', values: ['survival'], evidenceIds: expect.any(Array) },
      { trait: 'contentIntensity', values: [], evidenceIds: [] },
    ]);
    expect(pr.sources).toEqual([
      expect.objectContaining({
        key: 'goodreads_dataset',
        outcome: 'ok',
        providesText: true,
        ratingAverage: 4.33,
        ratingCount: 5000,
        reviewsUsed: 12,
      }),
      expect.objectContaining({
        key: 'open_library',
        name: 'Open Library',
        outcome: 'ok',
        ratingAverage: 4.13,
        ratingCount: 570,
        ratingScope: 'work',
        reviewsUsed: 0,
      }),
      expect.objectContaining({
        key: 'hardcover',
        name: 'Hardcover',
        outcome: 'ok',
        ratingScope: 'work',
      }),
    ]);
    // Three separate signals; no taste profile yet, so the invitation, not a score.
    expect(a.personalMatch).toMatchObject({
      status: 'needs_taste_data',
      score: null,
      tasteProfileVersion: null,
    });
    expect(llm.calls).toEqual({ traits: before.traits + 1, summary: before.summary + 1 });

    const history = await http()
      .get('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(analysisListSchema.safeParse(history.body).success).toBe(true);
    expect(history.body.items[0]).toMatchObject({ id: a.id, status: 'complete' });
  });

  it('a second request for the same book joins the running analysis instead of starting another', async () => {
    const token = await reader('join');
    const editionId = await book();
    let open!: () => void;
    llm.gate = new Promise((resolve) => (open = resolve));
    const first = await start(token, editionId).expect(201);
    const again = await start(token, editionId).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.status).toBe('running');
    open();
    await finished(token, first.body.id);
  });

  it('reuses a fresh public analysis of the book: no source or model is asked again (spec 10)', async () => {
    const editionId = await book();
    const first = await reader('reuse1');
    await finished(first, (await start(first, editionId).expect(201)).body.id);
    const calls = { ...llm.calls };
    const asked = openLibrary.asked;

    const second = await reader('reuse2');
    const a = await finished(second, (await start(second, editionId).expect(201)).body.id);
    expect(a.publicReception.summary).toBe(SUMMARY.summary);
    expect(llm.calls).toEqual(calls);
    expect(openLibrary.asked).toBe(asked);
  });

  it('RES-3: with zero usable reviews no written verdict is generated and no model is asked', async () => {
    const token = await reader('none');
    const editionId = await book({ reviews: 0, description: null });
    const calls = { ...llm.calls };
    const a = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(a.status).toBe('partial');
    expect(a.publicReception).toMatchObject({
      status: 'done',
      evidenceState: 'insufficient',
      summary: null,
      praises: [],
      complaints: [],
      evidenceConfidence: {
        level: 'low',
        reasons: ['No reviews with text', 'Ratings from 2 sources'],
      },
    });
    expect(a.steps.find((s) => s.name === 'publicSummary')!.status).toBe('done');
    expect(llm.calls).toEqual(calls);
  });

  it('RES-4: with every source failed the analysis fails with retry, never "no reviews"; retry reruns only what failed', async () => {
    const token = await reader('allfail');
    const editionId = await book();
    openLibrary.mode = 'failed';
    hardcover.mode = 'failed';
    const datasetDown = jest
      .spyOn(pipeline as unknown as { datasetSource: () => Promise<unknown> }, 'datasetSource')
      .mockResolvedValue({
        key: 'goodreads_dataset',
        name: 'Goodreads (UCSD Book Graph dataset)',
        outcome: 'failed',
        providesText: true,
        storageAllowed: true,
        ratingAverage: null,
        ratingCount: null,
        ratingScope: null,
        detail: 'internal',
        fetchedAt: new Date().toISOString(),
        expiresAt: null,
      });

    const id = (await start(token, editionId).expect(201)).body.id;
    const failed = await finished(token, id);
    expect(failed.status).toBe('failed');
    expect(failed.canRetry).toBe(true);
    expect(failed.publicReception).toMatchObject({
      status: 'failed',
      evidenceState: 'unavailable',
      summary: null,
    });
    expect(failed.publicReception.sources.map((s) => s.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(
      failed.steps.map((s) => `${s.name}:${s.status}${s.errorCode ? `:${s.errorCode}` : ''}`),
    ).toEqual([
      'resolve:done',
      'fetchReviews:failed:SOURCES_UNAVAILABLE',
      'selectReviews:skipped',
      'extractTraits:skipped',
      'publicSummary:skipped',
      'evidenceConfidence:skipped',
      'personalMatch:skipped',
      'finalize:done',
    ]);
    expect(failed.personalMatch.status).toBe('skipped');

    datasetDown.mockRestore();
    openLibrary.mode = 'ok';
    hardcover.mode = 'ok';
    const retried = await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(retried.body.status).toBe('running');
    const done = await finished(token, id);
    expect(done.status).toBe('complete');
    const attempts = await db.query(
      `SELECT step, attempt_count FROM analysis_steps WHERE analysis_id = $1`,
      [id],
    );
    const count = Object.fromEntries(attempts.rows.map((r) => [r.step, r.attempt_count]));
    // RES-2: the done step ran once; the failed one twice.
    expect(count).toMatchObject({ resolve: 1, fetchReviews: 2, selectReviews: 1 });
  });

  it('RES-2: invalid model output is retried once then fails; a retry does not repeat the done steps', async () => {
    const token = await reader('invalid');
    const editionId = await book();
    llm.summary = 'invalid';
    const before = { ...llm.calls };
    const id = (await start(token, editionId).expect(201)).body.id;
    const failed = await finished(token, id);
    expect(failed.steps.find((s) => s.name === 'publicSummary')).toEqual({
      name: 'publicSummary',
      status: 'failed',
      errorCode: 'INVALID_MODEL_OUTPUT',
    });
    expect(failed).toMatchObject({ status: 'failed', canRetry: true });
    expect(failed.publicReception.status).toBe('failed');
    expect(llm.calls.summary - before.summary).toBe(2);

    await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({ steps: ['resolve'] })
      .expect(400);
    llm.summary = 'ok';
    await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({ steps: ['publicSummary'] })
      .expect(200);
    const done = await finished(token, id);
    expect(done.status).toBe('complete');
    expect(llm.calls.traits - before.traits).toBe(1);
    await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409);
  });

  it('marks a used-up model quota as LLM_QUOTA_EXHAUSTED, retryable', async () => {
    const token = await reader('quota');
    const editionId = await book();
    llm.traits = 'quota';
    const a = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(a.steps.find((s) => s.name === 'extractTraits')!.errorCode).toBe('LLM_QUOTA_EXHAUSTED');
    expect(a.canRetry).toBe(true);
  });

  it('a source failing lowers confidence and is disclosed, but the analysis goes on (spec 11)', async () => {
    const token = await reader('somefail');
    const editionId = await book();
    hardcover.mode = 'failed';
    const a = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(a.status).toBe('partial');
    expect(a.publicReception.evidenceState).toBe('limited');
    expect(a.publicReception.sources.find((s) => s.key === 'hardcover')!.outcome).toBe('failed');
    expect(a.publicReception.evidenceConfidence!.reasons).toContain(
      'Hardcover could not be reached',
    );
  });

  it('MODEL-4: below the hard floor there is no score, and the numbers for the message are given', async () => {
    const token = await reader('floor');
    await rateBooks(token, 2);
    const a = await finished(token, (await start(token, await book()).expect(201)).body.id);
    expect(a.status).toBe('complete');
    expect(a.personalMatch).toMatchObject({
      status: 'below_floor',
      score: null,
      ratedCount: 2,
      hardFloor: 3,
      tasteProfileVersion: 2,
    });
  });

  it('RES-7: above the floor with no taste model yet, the personal match says so and the public reception stays', async () => {
    const token = await reader('nomodel');
    await rateBooks(token, 3);
    const id = (await start(token, await book()).expect(201)).body.id;
    const a = await finished(token, id);
    expect(a.status).toBe('partial');
    expect(a.publicReception).toMatchObject({ status: 'done', summary: SUMMARY.summary });
    expect(a.personalMatch).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_UNAVAILABLE',
      score: null,
      ratedCount: 3,
    });
    // Retrying cannot help until a model ships, so it is not offered.
    expect(a.canRetry).toBe(false);
    await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409);
  });

  it('ONB-4: a newer taste profile marks the analysis outdated; recalculating makes a new one and leaves the old unchanged', async () => {
    const token = await reader('recalc');
    const editionId = await book();
    const old = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(old.personalMatch.isOutdated).toBe(false);
    await http()
      .post(`/api/v1/analyses/${old.id}/recalculate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    await rateBooks(token, 1);
    const outdated = await finished(token, old.id);
    expect(outdated.personalMatch).toMatchObject({
      isOutdated: true,
      tasteProfileVersion: null,
      currentTasteProfileVersion: 1,
    });

    const res = await http()
      .post(`/api/v1/analyses/${old.id}/recalculate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(res.body.recalculatedFromId).toBe(old.id);
    const fresh = await finished(token, res.body.id);
    expect(fresh.personalMatch).toMatchObject({
      status: 'below_floor',
      tasteProfileVersion: 1,
      isOutdated: false,
    });
    const unchanged = await finished(token, old.id);
    expect(unchanged.personalMatch.status).toBe('needs_taste_data');
    expect(unchanged.finishedAt).toBe(old.finishedAt);
  });

  it('RES-1: an analysis left running by a stopped process is resumed from its unfinished step', async () => {
    const token = await reader('resume');
    const editionId = await book();
    let open!: () => void;
    llm.gate = new Promise((resolve) => (open = resolve));
    const id = (await start(token, editionId).expect(201)).body.id;
    open();
    await runner.idle();
    // Simulate a crash during the summary: the step was running and nothing after it ran.
    await db.query(
      `UPDATE analysis_steps SET status = 'running' WHERE analysis_id = $1 AND step = 'publicSummary'`,
      [id],
    );
    await db.query(
      `UPDATE analysis_steps SET status = 'pending', output = NULL WHERE analysis_id = $1 AND step IN ('evidenceConfidence', 'personalMatch', 'finalize')`,
      [id],
    );
    await db.query(`DELETE FROM personal_analyses WHERE analysis_id = $1`, [id]);
    await db.query(
      `UPDATE analyses SET status = 'running', finished_at = NULL, public_analysis_id = NULL WHERE id = $1`,
      [id],
    );
    expect(await runner.recover()).toBeGreaterThanOrEqual(1);
    const a = await finished(token, id);
    expect(a.status).toBe('complete');
  });

  it('an analysis whose pipeline breaks mid-step is marked failed with retry, never left running', async () => {
    const token = await reader('broken');
    const editionId = await book();
    // The step had started when the connection went away.
    const broken = jest
      .spyOn(
        pipeline as unknown as { runStep: (id: string, step: string) => Promise<void> },
        'runStep',
      )
      .mockImplementationOnce(async (analysisId: string, step: string) => {
        await db.query(
          `UPDATE analysis_steps SET status = 'running' WHERE analysis_id = $1 AND step = $2`,
          [analysisId, step],
        );
        throw new Error('connection lost');
      });
    const id = (await start(token, editionId).expect(201)).body.id;
    const a = await finished(token, id);
    broken.mockRestore();
    expect(a.status).toBe('failed');
    expect(a.finishedAt).not.toBeNull();
    expect(a.steps[0]).toEqual({ name: 'resolve', status: 'failed', errorCode: 'INTERNAL_ERROR' });
    expect(a.steps.slice(1).map((s) => s.status)).toEqual(Array(7).fill('skipped'));
    expect(a.canRetry).toBe(true);

    await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect((await finished(token, id)).status).toBe('complete');
  });

  it('SEC-1: another reader sees 404; unknown edition 404; bad body 400; history pages with a cursor', async () => {
    const owner = await reader('own');
    const other = await reader('other');
    const id = (await start(owner, await book()).expect(201)).body.id;
    await runner.idle();
    await get(other, id).expect(404);
    await get(owner, 'not-a-uuid').expect(404);
    await http()
      .post(`/api/v1/analyses/${id}/retry`)
      .set('Authorization', `Bearer ${other}`)
      .send({})
      .expect(404);
    await http()
      .post(`/api/v1/analyses/${id}/recalculate`)
      .set('Authorization', `Bearer ${other}`)
      .expect(404);
    await start(owner, randomUUID()).expect(404);
    const bad = await http()
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${owner}`)
      .send({ editionId: 'x' })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await http().get(`/api/v1/analyses/${id}`).expect(401);

    const second = (await start(owner, await book()).expect(201)).body.id;
    await runner.idle();
    const page1 = await http()
      .get('/api/v1/analyses?limit=1')
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([second]);
    const page2 = await http()
      .get(`/api/v1/analyses?limit=1&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    expect(page2.body).toMatchObject({ items: [{ id }], nextCursor: null });
    const otherHistory = await http()
      .get('/api/v1/analyses')
      .set('Authorization', `Bearer ${other}`)
      .expect(200);
    expect(otherHistory.body).toEqual({ items: [], nextCursor: null });
  });
});

describe('analysis rate limit', () => {
  it('limits starting analyses per reader per hour (spec 12)', async () => {
    const { app } = await createTestApp(
      { ANALYSIS_RECOVER_ON_START: 'false', RATE_LIMIT_ANALYSES_PER_HOUR: '1' },
      [
        { token: ANALYSIS_LLM, value: new FakeLlm() },
        { token: RATING_SOURCES, value: [] },
      ],
    );
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('rate'), password: 'analysis password', displayName: 'Rate' })
        .expect(201);
      const auth = `Bearer ${res.body.accessToken}`;
      const editionId = randomUUID();
      await request(app.getHttpServer())
        .post('/api/v1/analyses')
        .set('Authorization', auth)
        .send({ editionId })
        .expect(404);
      const limited = await request(app.getHttpServer())
        .post('/api/v1/analyses')
        .set('Authorization', auth)
        .send({ editionId })
        .expect(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    } finally {
      await app.get(AnalysisRunner).idle();
      await app.close();
    }
  });
});
