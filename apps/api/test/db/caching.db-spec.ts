import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { ANALYSIS_LLM } from '../../src/analysis/analysis-pipeline';
import { AnalysisRunner } from '../../src/analysis/analysis-runner';
import { analysisSchema } from '../../src/analysis/analysis.schemas';
import { RATING_SOURCES } from '../../src/sources/sources.tokens';
import { FakeLlm, FakeSource, REVIEW_TEXTS, SUMMARY, insertBook } from './analysis-helpers';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-9: reuse, shared builds and older data (spec 10, PERF-1 to PERF-3, D-025),
 * end to end against the real database. Sources and the model are fakes that
 * count their calls.
 */

/** The fake model, counting how many calls are in flight at once. */
class CountingLlm extends FakeLlm {
  inFlight = 0;
  maxInFlight = 0;
  delayMs = 0;

  constructor() {
    super();
    const inner = this.generateJson;
    this.generateJson = async (model: string, req: { system: string }) => {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        return await inner(model, req);
      } finally {
        this.inFlight--;
      }
    };
  }
}

describe('caching and shared builds (BE-9)', () => {
  let app: NestExpressApplication;
  let db: Client;
  let runner: AnalysisRunner;
  const llm = new CountingLlm();
  const openLibrary = new FakeSource('open_library', 4.13, 570);
  const hardcover = new FakeSource('hardcover', 4.2, 7991);
  const http = () => request(app.getHttpServer());

  async function reader(label: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(label), password: 'caching password', displayName: label })
      .expect(201);
    return res.body.accessToken as string;
  }

  const start = (token: string, editionId: string, refresh?: boolean) =>
    http()
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .send(refresh === undefined ? { editionId } : { editionId, refresh });

  async function finished(token: string, id: string) {
    await runner.idle();
    const res = await http()
      .get(`/api/v1/analyses/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const parsed = analysisSchema.safeParse(res.body);
    if (!parsed.success)
      throw new Error(
        `Not a valid Analysis: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return res.body as ReturnType<typeof analysisSchema.parse>;
  }

  const calls = () => ({
    openLibrary: openLibrary.asked,
    hardcover: hardcover.asked,
    traits: llm.calls.traits,
    summary: llm.calls.summary,
  });
  const since = (before: ReturnType<typeof calls>) => {
    const now = calls();
    return {
      openLibrary: now.openLibrary - before.openLibrary,
      hardcover: now.hardcover - before.hardcover,
      traits: now.traits - before.traits,
      summary: now.summary - before.summary,
    };
  };

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {
        ANALYSIS_RECOVER_ON_START: 'false',
        ANALYSIS_MAX_CONCURRENT: '10',
        RATE_LIMIT_ANALYSES_PER_HOUR: '1000',
        PUBLIC_BUILD_WAIT_POLL_MS: '20',
        REFRESH_PER_BOOK_PER_DAY: '3',
      },
      [
        { token: ANALYSIS_LLM, value: llm },
        { token: RATING_SOURCES, value: [openLibrary, hardcover] },
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
    llm.delayMs = 0;
    llm.maxInFlight = 0;
    openLibrary.mode = 'ok';
    hardcover.mode = 'ok';
  });

  afterAll(async () => {
    await runner.idle();
    await db.end();
    await app.close();
  });

  it('PERF-1: a repeat request within the reuse window makes no external review or model calls', async () => {
    const editionId = await insertBook(db);
    const first = await reader('perf1-a');
    await finished(first, (await start(first, editionId).expect(201)).body.id);
    const before = calls();
    const token = await reader('perf1-b');
    const a = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(a.status).toBe('complete');
    expect(since(before)).toEqual({ openLibrary: 0, hardcover: 0, traits: 0, summary: 0 });
  });

  it('PERF-2: ten simultaneous requests for one uncached book cause one set of external calls', async () => {
    const editionId = await insertBook(db);
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => reader(`perf2-${i}`)));
    const before = calls();
    let release!: () => void;
    llm.gate = new Promise<void>((r) => (release = r));
    const ids = (await Promise.all(tokens.map((t) => start(t, editionId).expect(201)))).map(
      (r) => r.body.id as string,
    );
    await new Promise((r) => setTimeout(r, 200)); // every analysis is now running or waiting
    release();
    const results = await Promise.all(ids.map((id, i) => finished(tokens[i]!, id)));
    expect(since(before)).toEqual({ openLibrary: 1, hardcover: 1, traits: 1, summary: 1 });
    expect(results.every((a) => a.status === 'complete')).toBe(true);
    const shared = await db.query(
      `SELECT count(DISTINCT public_analysis_id)::int AS n FROM analyses WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(shared.rows[0].n).toBe(1);
    const claims = await db.query(
      'SELECT count(*)::int AS n FROM public_analysis_builds WHERE edition_id = $1',
      [editionId],
    );
    expect(claims.rows[0].n).toBe(0);
  });

  it('PERF-1: a rebuild asks again only the source whose answer expired, and reuses the model output for the same evidence', async () => {
    const editionId = await insertBook(db);
    const token = await reader('rebuild');
    openLibrary.mode = 'failed';
    const first = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(first.status).toBe('partial');
    // Open Library's failure and the public analysis built with it have expired.
    await db.query(
      `UPDATE public_analyses SET expires_at = now() - interval '1 minute' WHERE edition_id = $1`,
      [editionId],
    );
    await db.query(
      `UPDATE review_fetches SET expires_at = now() - interval '1 minute'
        WHERE edition_id = $1 AND source_id = (SELECT id FROM review_sources WHERE key = 'open_library')`,
      [editionId],
    );
    openLibrary.mode = 'ok';
    const before = calls();
    const again = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(again.status).toBe('complete');
    expect(since(before)).toEqual({ openLibrary: 1, hardcover: 0, traits: 0, summary: 0 });
    expect(again.publicReception.summary).toBe(SUMMARY.summary);
    const hc = again.publicReception.sources.find((s) => s.key === 'hardcover')!;
    expect(hc).toMatchObject({ outcome: 'ok', ratingAverage: 4.2 });
  });

  it('runs trait extraction and the summary at the same time (blocker 7)', async () => {
    const token = await reader('parallel');
    llm.delayMs = 150;
    const a = await finished(token, (await start(token, await insertBook(db)).expect(201)).body.id);
    expect(a.status).toBe('complete');
    expect(llm.maxInFlight).toBe(2);
  });

  it('a build claim left by a stopped process is taken over', async () => {
    const editionId = await insertBook(db);
    const token = await reader('abandoned');
    const other = await finished(
      token,
      (await start(token, await insertBook(db)).expect(201)).body.id,
    );
    await db.query(
      `INSERT INTO public_analysis_builds (edition_id, analysis_id, claimed_at) VALUES ($1, $2, now() - interval '1 hour')`,
      [editionId, other.id],
    );
    const a = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(a.status).toBe('complete');
  });

  it('PERF-3, spec 10: a failed refresh serves the older reception labeled with its date; the step can be retried', async () => {
    const editionId = await insertBook(db);
    const token = await reader('stale');
    const original = await finished(token, (await start(token, editionId).expect(201)).body.id);
    expect(original.publicReception.stale).toBe(false);

    // A new review changes the evidence, so the model must be asked, and its quota is used up.
    const text = `${REVIEW_TEXTS[0]} Added later, with a different view of the ending entirely.`;
    await db.query(
      `INSERT INTO reviews (id, edition_id, source_id, external_review_id, rating, text, text_length, language)
       VALUES ($1, $2, (SELECT id FROM review_sources WHERE key = 'goodreads_dataset'), $3, 3, $4, $5, 'en')`,
      [randomUUID(), editionId, `${editionId}-late`, text, text.length],
    );
    llm.traits = 'quota';
    llm.summary = 'quota';
    const refreshed = await finished(
      token,
      (await start(token, editionId, true).expect(201)).body.id,
    );
    expect(refreshed.status).toBe('partial');
    expect(refreshed.steps.find((s) => s.name === 'extractTraits')).toMatchObject({
      status: 'failed',
      errorCode: 'LLM_QUOTA_EXHAUSTED',
    });
    expect(refreshed.publicReception).toMatchObject({
      status: 'done',
      stale: true,
      summary: SUMMARY.summary,
      generatedAt: original.publicReception.generatedAt,
    });
    // The personal match does not depend on the failed build.
    expect(refreshed.personalMatch.status).toBe('needs_taste_data');
    expect(refreshed.canRetry).toBe(true);

    llm.traits = 'ok';
    llm.summary = 'ok';
    await http()
      .post(`/api/v1/analyses/${refreshed.id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    const retried = await finished(token, refreshed.id);
    expect(retried.status).toBe('complete');
    expect(retried.publicReception.stale).toBe(false);
    expect(retried.publicReception.generatedAt).not.toBe(original.publicReception.generatedAt);
  });

  it('a refresh rebuilds even when a fresh reception exists, and is limited per book per day', async () => {
    const editionId = await insertBook(db);
    const token = await reader('refresh');
    await finished(token, (await start(token, editionId).expect(201)).body.id);
    const before = calls();
    await finished(token, (await start(token, editionId, true).expect(201)).body.id);
    // The sources are asked again; the model output is reused because the evidence is the same.
    expect(since(before)).toEqual({ openLibrary: 1, hardcover: 1, traits: 0, summary: 0 });

    await finished(token, (await start(token, editionId, true).expect(201)).body.id);
    await finished(token, (await start(token, editionId, true).expect(201)).body.id);
    const refused = await start(token, editionId, true).expect(429);
    expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(refused.body.retryAfterSeconds).toBeGreaterThan(86_000);
    // An ordinary request is not limited by refreshes.
    await start(token, editionId).expect(201);
    await runner.idle();
  });
});
