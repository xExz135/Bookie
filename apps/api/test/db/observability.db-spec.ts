import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { ANALYSIS_LLM } from '../../src/analysis/analysis-pipeline';
import { AnalysisRunner } from '../../src/analysis/analysis-runner';
import {
  buildReport,
  loadReportRows,
  parsePrices,
} from '../../src/observability/cost-latency-report';
import { RATING_SOURCES } from '../../src/sources/sources.tokens';
import { FakeLlm, FakeSource, insertBook } from './analysis-helpers';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-11: what each analysis cost and how its sources answered is stored
 * (H4, spec 9 cost and latency, spec 12 source outcomes, D-026), and the
 * report reads it back. The model and sources are fakes with known usage.
 */
describe('cost, latency and source outcomes (BE-11)', () => {
  let app: NestExpressApplication;
  let db: Client;
  let runner: AnalysisRunner;
  const llm = new FakeLlm();
  const openLibrary = new FakeSource('open_library', 4.13, 570);
  const hardcover = new FakeSource('hardcover', 4.2, 7991);
  const http = () => request(app.getHttpServer());

  const userIds = new Map<string, string>();

  async function reader(label: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(label), password: 'observability password', displayName: label })
      .expect(201);
    userIds.set(res.body.accessToken as string, res.body.user.id as string);
    return res.body.accessToken as string;
  }

  async function analysed(token: string, editionId: string): Promise<string> {
    const res = await http()
      .post('/api/v1/analyses')
      .set('Authorization', `Bearer ${token}`)
      .send({ editionId })
      .expect(201);
    await runner.idle();
    return res.body.id as string;
  }

  const callsOf = async (analysisId: string) =>
    (
      await db.query(
        `SELECT purpose, model, outcome, input_tokens, output_tokens, latency_ms, waited_ms
           FROM llm_calls WHERE analysis_id = $1 ORDER BY purpose, created_at`,
        [analysisId],
      )
    ).rows;

  const sourcesOf = async (analysisId: string) =>
    (
      await db.query(
        `SELECT source_key, outcome::text AS outcome, detail, cached
           FROM source_calls WHERE analysis_id = $1 ORDER BY source_key`,
        [analysisId],
      )
    ).rows;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {
        ANALYSIS_RECOVER_ON_START: 'false',
        RATE_LIMIT_ANALYSES_PER_HOUR: '1000',
        PUBLIC_BUILD_WAIT_POLL_MS: '20',
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
    openLibrary.mode = 'ok';
    hardcover.mode = 'ok';
  });

  afterAll(async () => {
    await runner.idle();
    await db.end();
    await app.close();
  });

  it('H4: a cold analysis stores each model call with its tokens and time, and each source answer', async () => {
    const token = await reader('cold');
    hardcover.mode = 'failed';
    const id = await analysed(token, await insertBook(db));
    expect(await callsOf(id)).toEqual([
      {
        purpose: 'extractTraits',
        model: 'fake',
        outcome: 'ok',
        input_tokens: 100,
        output_tokens: 20,
        latency_ms: 5,
        waited_ms: 0,
      },
      expect.objectContaining({ purpose: 'publicSummary', outcome: 'ok', input_tokens: 100 }),
    ]);
    // Spec 12: every live source with its outcome, a failure with its reason.
    expect(await sourcesOf(id)).toEqual([
      { source_key: 'hardcover', outcome: 'failed', detail: 'network', cached: false },
      { source_key: 'open_library', outcome: 'ok', detail: null, cached: false },
    ]);
  });

  it('records an invalid answer that was retried, and a request refused for quota', async () => {
    const token = await reader('invalid');
    llm.traits = 'invalid';
    llm.summary = 'quota';
    const id = await analysed(token, await insertBook(db));
    expect((await callsOf(id)).map((c) => [c.purpose, c.outcome, c.input_tokens])).toEqual([
      // Spec 8: the invalid answer is retried once; both attempts cost tokens.
      ['extractTraits', 'invalid_output', 100],
      ['extractTraits', 'invalid_output', 100],
      ['publicSummary', 'quota', 0],
    ]);
  });

  it('PERF-1: a cached analysis makes no model call and records nothing to pay for', async () => {
    const editionId = await insertBook(db);
    await analysed(await reader('first'), editionId);
    const id = await analysed(await reader('second'), editionId);
    expect(await callsOf(id)).toEqual([]);
    // The fresh public analysis was reused: no source was asked either.
    expect(await sourcesOf(id)).toEqual([]);
  });

  it('PERF-1: a rebuild records the reused source answers as cached', async () => {
    const editionId = await insertBook(db);
    const token = await reader('rebuild');
    await analysed(token, editionId);
    await db.query(
      `UPDATE public_analyses SET expires_at = now() - interval '1 minute' WHERE edition_id = $1`,
      [editionId],
    );
    const id = await analysed(token, editionId);
    expect(await sourcesOf(id)).toEqual([
      { source_key: 'hardcover', outcome: 'ok', detail: null, cached: true },
      { source_key: 'open_library', outcome: 'ok', detail: null, cached: true },
    ]);
    // Same evidence, model and prompt: the outputs were reused, no call (D-025).
    expect(await callsOf(id)).toEqual([]);
  });

  it('the report reads cold and cached analyses, tokens, cost and reuse from the database', async () => {
    const since = new Date();
    const editionId = await insertBook(db);
    const first = await reader('report-cold');
    const second = await reader('report-cached');
    const cold = await analysed(first, editionId);
    const cached = await analysed(second, editionId);
    // Other test files run analyses at the same time: only these two readers count.
    const rows = await loadReportRows(
      db,
      { since, until: new Date(Date.now() + 1000) },
      { userIds: [userIds.get(first)!, userIds.get(second)!] },
    );
    expect(rows.analyses.map((a) => a.id)).toEqual([cold, cached]);
    const report = buildReport(rows, {
      window: { since, until: new Date() },
      prices: parsePrices('fake=1/10,bigger=2/20'),
      comparisonModel: 'bigger',
      sharedAfterMs: 20,
      resamples: 100,
      seed: 1,
    });
    expect(report.analyses.byKind).toEqual({ cold: 1, cached: 1, shared: 0 });
    expect(report.latencyMs.cold.n).toBe(1);
    expect(report.latencyMs.cached.n).toBe(1);
    expect(report.tokensPerColdAnalysis).toMatchObject({
      n: 1,
      calls: { value: 2 },
      inputTokens: { value: 200 },
      outputTokens: { value: 40 },
    });
    // 200 input tokens at $1 and 40 output tokens at $10 per million.
    expect(report.costPerColdAnalysisUsd.measured.value).toBeCloseTo(0.0006, 12);
    expect(report.costPerColdAnalysisUsd.comparison.value).toBeCloseTo(0.0012, 12);
    expect(report.reuse.publicReception).toMatchObject({ hits: 1, n: 2 });
    expect(report.reuse.modelCallsAvoided).toBe(2);
    expect(report.sources.open_library).toMatchObject({ answers: 1, live: 1, outcomes: { ok: 1 } });
  });

  it('SEC-3: deleting an analysis keeps its cost rows without the link to the reader', async () => {
    const id = await analysed(await reader('deleted'), await insertBook(db));
    await db.query(`DELETE FROM analyses WHERE id = $1`, [id]);
    expect(await callsOf(id)).toEqual([]);
    const orphans = await db.query(
      `SELECT count(*)::int AS n FROM llm_calls WHERE analysis_id IS NULL AND created_at > now() - interval '1 minute'`,
    );
    expect(orphans.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
