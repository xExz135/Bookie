import {
  type AnalysisRow,
  type LlmCallRow,
  type ReportOptions,
  type ReportRows,
  buildReport,
  kindOf,
  parsePrices,
  renderReport,
} from './cost-latency-report';

const T0 = new Date('2026-10-22T07:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function analysis(id: string, ms: number, extra: Partial<AnalysisRow> = {}): AnalysisRow {
  return {
    id,
    status: 'complete',
    createdAt: T0,
    finishedAt: at(ms),
    reused: false,
    resolveWaitedMs: 3,
    retried: false,
    stale: false,
    reusedOutputs: 0,
    ...extra,
  };
}

function call(analysisId: string, purpose: string, extra: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    analysisId,
    purpose,
    model: 'small',
    outcome: 'ok',
    inputTokens: 9000,
    outputTokens: 500,
    latencyMs: 6000,
    waitedMs: 0,
    ...extra,
  };
}

const options: ReportOptions = {
  window: { since: T0, until: at(3_600_000) },
  prices: parsePrices('small=0.30/2.50,large=0.75/3.75'),
  comparisonModel: 'large',
  sharedAfterMs: 500,
  resamples: 200,
  seed: 1,
};

const rows: ReportRows = {
  analyses: [
    analysis('cold-1', 10_000),
    analysis('cold-2', 20_000),
    analysis('cold-3', 30_000),
    // Rebuilt with the same evidence: both model outputs reused, no call.
    analysis('cold-reuse', 4_000, { reusedOutputs: 2 }),
    analysis('cached-1', 100, { reused: true }),
    analysis('cached-2', 200, { reused: true }),
    analysis('shared-1', 15_000, { reused: true, resolveWaitedMs: 12_000 }),
    // Left out of latency.
    analysis('retried', 90_000, { retried: true }),
    analysis('stale', 9_000, { status: 'partial', stale: true }),
    analysis('failed', 2_000, { status: 'failed' }),
    analysis('running', 0, { status: 'running', finishedAt: null }),
  ],
  steps: [
    { analysisId: 'cold-1', step: 'fetchReviews', status: 'done', durationMs: 800, reused: false },
    { analysisId: 'cold-2', step: 'fetchReviews', status: 'done', durationMs: 1200, reused: false },
    { analysisId: 'cold-3', step: 'fetchReviews', status: 'done', durationMs: 1000, reused: false },
    {
      analysisId: 'cold-reuse',
      step: 'extractTraits',
      status: 'done',
      durationMs: 5,
      reused: true,
    },
    { analysisId: 'cached-1', step: 'extractTraits', status: 'done', durationMs: 0, reused: true },
  ],
  llmCalls: [
    call('cold-1', 'extractTraits'),
    call('cold-1', 'publicSummary', { latencyMs: 8000 }),
    // Waited 5 s under our pacing, then answered invalidly once and was retried.
    call('cold-2', 'extractTraits', { outcome: 'invalid_output', waitedMs: 5000 }),
    call('cold-2', 'extractTraits'),
    call('cold-2', 'publicSummary'),
    call('cold-3', 'extractTraits'),
    call('cold-3', 'publicSummary'),
    call('failed', 'extractTraits', { outcome: 'quota', inputTokens: 0, outputTokens: 0 }),
  ],
  sourceCalls: [
    {
      analysisId: 'cold-1',
      sourceKey: 'open_library',
      outcome: 'ok',
      detail: null,
      cached: false,
      durationMs: 300,
    },
    {
      analysisId: 'cold-2',
      sourceKey: 'open_library',
      outcome: 'failed',
      detail: 'timeout',
      cached: false,
      durationMs: 8000,
    },
    {
      analysisId: 'cold-3',
      sourceKey: 'open_library',
      outcome: 'ok',
      detail: null,
      cached: false,
      durationMs: 500,
    },
    {
      analysisId: 'cold-reuse',
      sourceKey: 'open_library',
      outcome: 'ok',
      detail: null,
      cached: true,
      durationMs: 0,
    },
    {
      analysisId: 'cold-1',
      sourceKey: 'hardcover',
      outcome: 'empty',
      detail: 'not_found',
      cached: false,
      durationMs: 400,
    },
  ],
};

describe('cost and latency report (H4, spec 9, D-026)', () => {
  const report = buildReport(rows, options);

  it('reads prices as model=input/output per million tokens', () => {
    expect(options.prices).toEqual({
      small: { input: 0.3, output: 2.5 },
      large: { input: 0.75, output: 3.75 },
    });
    expect(() => parsePrices('small=cheap')).toThrow('Cannot read the price');
  });

  it('sorts analyses into cold, cached and shared (PERF-1, PERF-2)', () => {
    expect(kindOf(rows.analyses[0]!, 500)).toBe('cold');
    expect(kindOf(rows.analyses[4]!, 500)).toBe('cached');
    expect(kindOf(rows.analyses[6]!, 500)).toBe('shared');
    expect(report.analyses.finished).toBe(10);
    expect(report.analyses.byKind).toEqual({ cold: 7, cached: 2, shared: 1 });
    expect(report.analyses.byStatus).toEqual({ complete: 8, partial: 1, failed: 1 });
    expect(report.analyses.excludedFromLatency).toEqual({ retried: 1, stale: 1, failed: 1 });
  });

  it('H4: p50 and p95 latency for cold and cached requests, with seeded intervals', () => {
    // Cold: 4, 10, 20 and 30 s.
    expect(report.latencyMs.cold.n).toBe(4);
    expect(report.latencyMs.cold.p50.value).toBe(15_000);
    expect(report.latencyMs.cold.p95.value).toBeCloseTo(28_500, 6);
    expect(report.latencyMs.cold.p50.low).not.toBeNull();
    expect(report.latencyMs.cached.n).toBe(2);
    expect(report.latencyMs.cached.p50.value).toBe(150);
    expect(report.latencyMs.shared.n).toBe(1);
    expect(report.latencyMs.shared.p50.low).toBeNull();
    expect(buildReport(rows, options)).toEqual(report);
  });

  it('separates our free-tier pacing wait from model time; parallel steps count once', () => {
    // cold-2 waited 5 s in traits; summary ran alongside. The others waited nothing.
    expect(report.coldBreakdownMs.pacingWait.p95.value).toBeGreaterThan(0);
    expect(report.coldBreakdownMs.pacingWait.p50.value).toBe(0);
    // Model time per analysis: cold-1 max(6, 8) = 8 s, cold-2 max(12, 6) = 12 s, cold-3 6 s;
    // the reuse build made no call and is not counted.
    expect(report.coldBreakdownMs.modelTime.p50.value).toBe(8000);
    expect(report.coldBreakdownMs.modelTime.p50.n).toBe(3);
    expect(report.coldBreakdownMs.steps.fetchReviews).toEqual({ n: 3, p50: 1000, p95: 1180 });
    // A reused step's near-zero time is not a step time.
    expect(report.coldBreakdownMs.steps.extractTraits).toBeUndefined();
  });

  it('H4: tokens and cost per cold analysis, and the saving against the larger model', () => {
    const t = report.tokensPerColdAnalysis;
    // cold-1 and cold-3 made 2 calls, cold-2 made 3; the reuse build made none.
    expect(t.n).toBe(3);
    expect(t.calls.value).toBeCloseTo(7 / 3, 10);
    expect(t.inputTokens.value).toBeCloseTo((9000 * 7) / 3, 6);
    const perCall = (9000 * 0.3 + 500 * 2.5) / 1e6;
    const perCallLarge = (9000 * 0.75 + 500 * 3.75) / 1e6;
    const c = report.costPerColdAnalysisUsd;
    expect(c.measured.value).toBeCloseTo((perCall * 7) / 3, 12);
    expect(c.comparison.value).toBeCloseTo((perCallLarge * 7) / 3, 12);
    expect(c.savedPerAnalysis).toBeCloseTo(((perCallLarge - perCall) * 7) / 3, 12);
    expect(c.unpricedModels).toEqual([]);
  });

  it('names models without a price instead of pricing them at zero', () => {
    const unpriced = buildReport(
      { ...rows, llmCalls: rows.llmCalls.map((c) => ({ ...c, model: 'mystery' })) },
      options,
    );
    expect(unpriced.costPerColdAnalysisUsd.unpricedModels).toEqual(['mystery']);
    expect(unpriced.costPerColdAnalysisUsd.measured.value).toBeNull();
    expect(unpriced.costPerColdAnalysisUsd.comparison.value).not.toBeNull();
  });

  it('spec 9: cache hit rate and the model calls reuse avoided', () => {
    expect(report.reuse.publicReception).toMatchObject({ hits: 3, n: 10, value: 0.3 });
    expect(report.reuse.sourceAnswers).toMatchObject({ hits: 1, n: 5 });
    expect(report.reuse.modelOutputsReused).toBe(2);
    expect(report.reuse.buildsAvoided).toBe(3);
    // 3 builds avoided x 7/3 calls per build = 7, plus 2 reused outputs.
    expect(report.reuse.modelCallsAvoided).toBe(9);
  });

  it('spec 12: model call outcomes and each source with its outcomes and time', () => {
    expect(report.modelCalls.total).toBe(8);
    expect(report.modelCalls.byOutcome).toEqual({ ok: 6, invalid_output: 1, quota: 1 });
    expect(report.modelCalls.invalidOutput).toMatchObject({ hits: 1, n: 8 });
    expect(report.sources.open_library).toEqual({
      answers: 4,
      cached: 1,
      live: 3,
      outcomes: { ok: 3, failed: 1 },
      details: { timeout: 1 },
      liveMs: { p50: 500, p95: 7250 },
    });
    expect(report.sources.hardcover!.details).toEqual({ not_found: 1 });
  });

  it('renders the tables for the README', () => {
    const md = renderReport(report);
    expect(md).toContain('| cold | 4 | 15.0 s (');
    expect(md).toContain('| Same tokens at large |');
    expect(md).toContain('| Analyses that reused a public reception | 3 of 10 (0.30, 95% interval');
    expect(md).toContain(
      '| open_library | 4 | 1 | 3 | ok 3, failed 1 (timeout 1) | 0.5 s | 7.3 s |',
    );
    expect(md).toContain('The free tier used for these runs costs nothing');
  });
});
