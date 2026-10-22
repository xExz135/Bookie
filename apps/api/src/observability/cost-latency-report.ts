import type { Client } from 'pg';
import { type Estimate, type Rate, bootstrap, mean, quantile, wilson } from './stats';

/**
 * The cost and latency report (spec 9 "Cost and latency", H4, D-026), built
 * from what the pipeline records: analyses and their steps, `llm_calls` and
 * `source_calls`. Loading reads the database; everything after that is a pure
 * function of the rows, so the same rows give the same report.
 */

export interface AnalysisRow {
  id: string;
  status: 'running' | 'complete' | 'partial' | 'failed';
  createdAt: Date;
  finishedAt: Date | null;
  /** The resolve step reused a public analysis (fresh, or one another analysis built). */
  reused: boolean;
  /** How long resolve waited before it could reuse or build (PERF-2). */
  resolveWaitedMs: number;
  /** Any step ran more than once (a retry), so the analysis time includes the reader's wait. */
  retried: boolean;
  /** A public step failed and an older reception is shown (PERF-3). */
  stale: boolean;
  /** Trait or summary outputs taken from an earlier build with the same evidence (D-025). */
  reusedOutputs: number;
}

export interface StepRow {
  analysisId: string;
  step: string;
  status: string;
  durationMs: number | null;
  reused: boolean;
}

export interface LlmCallRow {
  analysisId: string;
  purpose: string;
  model: string;
  outcome: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  waitedMs: number;
}

export interface SourceCallRow {
  analysisId: string;
  sourceKey: string;
  outcome: string;
  detail: string | null;
  cached: boolean;
  durationMs: number;
}

export interface ReportRows {
  analyses: AnalysisRow[];
  steps: StepRow[];
  llmCalls: LlmCallRow[];
  sourceCalls: SourceCallRow[];
}

export type Prices = Record<string, { input: number; output: number }>;

export interface ReportOptions {
  window: { since: Date; until: Date };
  prices: Prices;
  comparisonModel: string;
  /** Below this resolve wait an analysis counts as cached, above it as shared (it waited for a build). */
  sharedAfterMs: number;
  resamples: number;
  seed: number;
}

/** "gemini-3.5-flash-lite=0.30/2.50,gemini-3.8-flash=0.75/3.75" as prices per million tokens. */
export function parsePrices(text: string): Prices {
  const prices: Prices = {};
  for (const pair of text.split(',')) {
    const [model, rest] = pair.split('=');
    const [input, output] = (rest ?? '').split('/').map(Number);
    if (!model || !Number.isFinite(input) || !Number.isFinite(output))
      throw new Error(`Cannot read the price "${pair}"`);
    prices[model.trim()] = { input: input!, output: output! };
  }
  return prices;
}

export type AnalysisKind = 'cold' | 'cached' | 'shared';

/**
 * Cold: this analysis built the public reception (or tried to). Cached: it
 * reused a fresh one at once (PERF-1). Shared: it waited for another
 * analysis's build of the same book and reused that (PERF-2).
 */
export function kindOf(a: AnalysisRow, sharedAfterMs: number): AnalysisKind {
  if (!a.reused) return 'cold';
  return a.resolveWaitedMs < sharedAfterMs ? 'cached' : 'shared';
}

const groupBy = <T>(rows: readonly T[], key: (row: T) => string) => {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
};

const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);

/** A quantile of times in whole milliseconds. */
const msQuantile = (values: readonly number[], q: number) => {
  const v = quantile(values, q);
  return v === null ? null : Math.round(v);
};

function costOf(calls: readonly LlmCallRow[], prices: Prices, asModel?: string): number | null {
  let total = 0;
  for (const c of calls) {
    const price = prices[asModel ?? c.model];
    if (!price) return null;
    total += (c.inputTokens * price.input + c.outputTokens * price.output) / 1e6;
  }
  return total;
}

/**
 * Time of the parallel model steps: the steps' waits (or model times) add up
 * within a step and overlap between steps, so the longer step counts.
 */
function parallelTotal(calls: readonly LlmCallRow[], field: 'waitedMs' | 'latencyMs'): number {
  const perStep = [...groupBy(calls, (c) => c.purpose).values()].map((list) =>
    sum(list.map((c) => c[field])),
  );
  return perStep.length === 0 ? 0 : Math.max(...perStep);
}

export interface LatencySummary {
  p50: Estimate;
  p95: Estimate;
}

export interface CostLatencyReport {
  window: { since: string; until: string };
  method: string[];
  analyses: {
    finished: number;
    byKind: Record<AnalysisKind, number>;
    byStatus: Record<string, number>;
    /** Left out of the latency numbers: a retry (the time includes the reader's wait) or a stale fallback. */
    excludedFromLatency: { retried: number; stale: number; failed: number };
  };
  latencyMs: Record<AnalysisKind, LatencySummary & { n: number }>;
  coldBreakdownMs: {
    /** Time spent waiting under our own pacing for the free tier's per-minute caps. */
    /** Over cold analyses with recorded model calls. */
    pacingWait: LatencySummary;
    modelTime: LatencySummary;
    withoutPacingWait: LatencySummary;
    steps: Record<string, { n: number; p50: number | null; p95: number | null }>;
  };
  tokensPerColdAnalysis: {
    n: number;
    calls: Estimate;
    inputTokens: Estimate;
    outputTokens: Estimate;
  };
  costPerColdAnalysisUsd: {
    /** At the paid-tier list prices of the models used; the free tier costs nothing. */
    measured: Estimate;
    /** The same tokens priced at the comparison model (spec 9 tiered model use). */
    comparison: Estimate & { model: string };
    savedPerAnalysis: number | null;
    unpricedModels: string[];
  };
  reuse: {
    /** Share of finished analyses that reused a public reception (cached or shared). */
    publicReception: Rate;
    /** Live source answers taken from an earlier fetch (PERF-1). */
    sourceAnswers: Rate;
    /** Model outputs reused from an earlier build with the same evidence (D-025). */
    modelOutputsReused: number;
    /** Public builds not made because a reception was reused. */
    buildsAvoided: number;
    /** Estimated model calls not made: builds avoided times calls per cold build, plus reused outputs. */
    modelCallsAvoided: number | null;
  };
  modelCalls: {
    total: number;
    byOutcome: Record<string, number>;
    invalidOutput: Rate;
  };
  sources: Record<
    string,
    {
      answers: number;
      cached: number;
      live: number;
      outcomes: Record<string, number>;
      details: Record<string, number>;
      liveMs: { p50: number | null; p95: number | null };
    }
  >;
  params: { resamples: number; seed: number; prices: Prices; sharedAfterMs: number };
}

export function buildReport(rows: ReportRows, options: ReportOptions): CostLatencyReport {
  const boot = (values: number[], stat: (v: readonly number[]) => number | null) =>
    bootstrap(values, stat, { resamples: options.resamples, seed: options.seed });
  const latency = (values: number[]): LatencySummary => ({
    p50: boot(values, (v) => quantile(v, 0.5)),
    p95: boot(values, (v) => quantile(v, 0.95)),
  });

  const finished = rows.analyses.filter((a) => a.status !== 'running' && a.finishedAt);
  const kind = new Map(finished.map((a) => [a.id, kindOf(a, options.sharedAfterMs)]));
  const callsOf = groupBy(rows.llmCalls, (c) => c.analysisId);
  const stepsOf = groupBy(rows.steps, (s) => s.analysisId);

  const eligible = finished.filter(
    (a) => (a.status === 'complete' || a.status === 'partial') && !a.retried && !a.stale,
  );
  const timeOf = (a: AnalysisRow) => a.finishedAt!.getTime() - a.createdAt.getTime();
  const latencyMs = {} as CostLatencyReport['latencyMs'];
  for (const k of ['cold', 'cached', 'shared'] as const) {
    const values = eligible.filter((a) => kind.get(a.id) === k).map(timeOf);
    latencyMs[k] = { n: values.length, ...latency(values) };
  }

  // Cold builds that ran their model steps (no model outputs reused), for tokens and cost.
  const cold = eligible.filter((a) => kind.get(a.id) === 'cold');
  const coldCalls = cold.map((a) => callsOf.get(a.id) ?? []);
  const fullBuilds = cold
    .map((a, i) => ({ a, calls: coldCalls[i]! }))
    .filter(({ a, calls }) => a.reusedOutputs === 0 && calls.length > 0);
  // Model time and pacing wait only where calls were recorded (none before BE-11, none when reused).
  const called = cold
    .map((a, i) => ({ a, calls: coldCalls[i]! }))
    .filter(({ calls }) => calls.length > 0);
  const pacing = called.map(({ calls }) => parallelTotal(calls, 'waitedMs'));
  const modelTime = called.map(({ calls }) => parallelTotal(calls, 'latencyMs'));

  const steps: CostLatencyReport['coldBreakdownMs']['steps'] = {};
  const coldSteps = cold.flatMap((a) => stepsOf.get(a.id) ?? []);
  for (const [name, list] of groupBy(
    coldSteps.filter((s) => s.status === 'done' && !s.reused && s.durationMs !== null),
    (s) => s.step,
  )) {
    const values = list.map((s) => s.durationMs!);
    steps[name] = { n: values.length, p50: msQuantile(values, 0.5), p95: msQuantile(values, 0.95) };
  }

  const usedModels = new Set(rows.llmCalls.map((c) => c.model));
  const unpricedModels = [...usedModels].filter((m) => !options.prices[m]).sort();
  const measuredCosts = fullBuilds.map(({ calls }) => costOf(calls, options.prices));
  const comparisonCosts = fullBuilds.map(({ calls }) =>
    costOf(calls, options.prices, options.comparisonModel),
  );
  const priced = (values: Array<number | null>) =>
    values.every((v) => v !== null) ? (values as number[]) : [];
  const measured = boot(priced(measuredCosts), mean);
  const comparison = boot(priced(comparisonCosts), mean);

  const reusedCount = finished.filter((a) => kind.get(a.id) !== 'cold').length;
  const outputsReused = sum(finished.map((a) => a.reusedOutputs));
  const callsPerBuild = mean(fullBuilds.map(({ calls }) => calls.length));

  const byOutcome: Record<string, number> = {};
  for (const c of rows.llmCalls) byOutcome[c.outcome] = (byOutcome[c.outcome] ?? 0) + 1;

  const sources: CostLatencyReport['sources'] = {};
  for (const [key, list] of [...groupBy(rows.sourceCalls, (s) => s.sourceKey)].sort()) {
    const live = list.filter((s) => !s.cached);
    const outcomes: Record<string, number> = {};
    const details: Record<string, number> = {};
    for (const s of list) {
      outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
      if (s.detail) details[s.detail] = (details[s.detail] ?? 0) + 1;
    }
    const ms = live.map((s) => s.durationMs);
    sources[key] = {
      answers: list.length,
      cached: list.length - live.length,
      live: live.length,
      outcomes,
      details,
      liveMs: { p50: msQuantile(ms, 0.5), p95: msQuantile(ms, 0.95) },
    };
  }

  const count = <T>(list: readonly T[], key: (row: T) => string) => {
    const out: Record<string, number> = {};
    for (const row of list) out[key(row)] = (out[key(row)] ?? 0) + 1;
    return out;
  };

  return {
    window: {
      since: options.window.since.toISOString(),
      until: options.window.until.toISOString(),
    },
    method: [
      'Analyses created in the window and finished; latency is server time from the request to the final status (the reader also waits for the first poll).',
      'Cold: the analysis built the public reception. Cached: it reused a fresh one at once. Shared: it waited for another analysis building the same book (PERF-2).',
      'Latency leaves out analyses with a retried step (their time includes the reader), stale fallbacks (PERF-3) and failed ones.',
      'Quantiles interpolate linearly (numpy default). Intervals are 95% percentile bootstrap over analyses, seeded; rates use the Wilson interval.',
      'Tokens and cost: cold builds that called the model and reused no earlier output; a book with no usable reviews makes only the trait call. Cost uses paid-tier list prices; the free tier used here costs nothing.',
      'Pacing wait: time our client held requests back for the free-tier per-minute caps; the two model steps run in parallel, so the longer step counts.',
    ],
    analyses: {
      finished: finished.length,
      byKind: {
        cold: finished.filter((a) => kind.get(a.id) === 'cold').length,
        cached: finished.filter((a) => kind.get(a.id) === 'cached').length,
        shared: finished.filter((a) => kind.get(a.id) === 'shared').length,
      },
      byStatus: count(finished, (a) => a.status),
      excludedFromLatency: {
        retried: finished.filter((a) => a.retried).length,
        stale: finished.filter((a) => a.stale && !a.retried).length,
        failed: finished.filter((a) => a.status === 'failed' && !a.retried && !a.stale).length,
      },
    },
    latencyMs,
    coldBreakdownMs: {
      pacingWait: latency(pacing),
      modelTime: latency(modelTime),
      withoutPacingWait: latency(called.map(({ a }, i) => timeOf(a) - pacing[i]!)),
      steps,
    },
    tokensPerColdAnalysis: {
      n: fullBuilds.length,
      calls: boot(
        fullBuilds.map(({ calls }) => calls.length),
        mean,
      ),
      inputTokens: boot(
        fullBuilds.map(({ calls }) => sum(calls.map((c) => c.inputTokens))),
        mean,
      ),
      outputTokens: boot(
        fullBuilds.map(({ calls }) => sum(calls.map((c) => c.outputTokens))),
        mean,
      ),
    },
    costPerColdAnalysisUsd: {
      measured,
      comparison: { ...comparison, model: options.comparisonModel },
      savedPerAnalysis:
        measured.value !== null && comparison.value !== null
          ? comparison.value - measured.value
          : null,
      unpricedModels,
    },
    reuse: {
      publicReception: wilson(reusedCount, finished.length),
      sourceAnswers: wilson(
        rows.sourceCalls.filter((s) => s.cached).length,
        rows.sourceCalls.length,
      ),
      modelOutputsReused: outputsReused,
      buildsAvoided: reusedCount,
      modelCallsAvoided:
        callsPerBuild === null ? null : Math.round(reusedCount * callsPerBuild) + outputsReused,
    },
    modelCalls: {
      total: rows.llmCalls.length,
      byOutcome,
      invalidOutput: wilson(byOutcome.invalid_output ?? 0, rows.llmCalls.length),
    },
    sources,
    params: {
      resamples: options.resamples,
      seed: options.seed,
      prices: options.prices,
      sharedAfterMs: options.sharedAfterMs,
    },
  };
}

/**
 * The rows of the analyses created in the window; with `userIds`, only those
 * readers' analyses (a benchmark run, unaffected by anyone else's).
 */
export async function loadReportRows(
  db: Pick<Client, 'query'>,
  window: { since: Date; until: Date },
  filter: { userIds?: string[] } = {},
): Promise<ReportRows> {
  const analyses = await db.query<{
    id: string;
    status: AnalysisRow['status'];
    created_at: Date;
    finished_at: Date | null;
    reused: boolean;
    resolve_waited_ms: number | null;
    retried: boolean;
    stale: boolean;
    reused_outputs: number;
  }>(
    `SELECT a.id, a.status::text AS status, a.created_at, a.finished_at,
            COALESCE(r.output ->> 'reusedPublicAnalysisId', '') <> '' AS reused,
            (r.output ->> 'waitedMs')::int AS resolve_waited_ms,
            EXISTS (SELECT 1 FROM analysis_steps s WHERE s.analysis_id = a.id AND s.attempt_count > 1) AS retried,
            (a.public_analysis_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM analysis_steps s WHERE s.analysis_id = a.id AND s.status = 'failed'
                 AND s.step IN ('fetchReviews', 'selectReviews', 'extractTraits', 'publicSummary', 'evidenceConfidence'))) AS stale,
            (SELECT count(*)::int FROM analysis_steps s WHERE s.analysis_id = a.id
               AND s.step IN ('extractTraits', 'publicSummary') AND s.output ? 'reusedFrom') AS reused_outputs
       FROM analyses a
       LEFT JOIN analysis_steps r ON r.analysis_id = a.id AND r.step = 'resolve'
      WHERE a.created_at >= $1 AND a.created_at < $2
        AND ($3::uuid[] IS NULL OR a.user_id = ANY($3::uuid[]))
      ORDER BY a.created_at`,
    [window.since, window.until, filter.userIds ?? null],
  );
  const ids = analyses.rows.map((a) => a.id);
  const steps = await db.query<{
    analysis_id: string;
    step: string;
    status: string;
    duration_ms: number | null;
    reused: boolean;
  }>(
    `SELECT analysis_id, step::text AS step, status::text AS status, duration_ms,
            COALESCE(output ? 'reused' OR output ? 'reusedFrom', false) AS reused
       FROM analysis_steps WHERE analysis_id = ANY($1::uuid[])`,
    [ids],
  );
  const llm = await db.query<{
    analysis_id: string;
    purpose: string;
    model: string;
    outcome: string;
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    waited_ms: number;
  }>(
    `SELECT analysis_id, purpose, model, outcome, input_tokens, output_tokens, latency_ms, waited_ms
       FROM llm_calls WHERE analysis_id = ANY($1::uuid[]) ORDER BY created_at`,
    [ids],
  );
  const sources = await db.query<{
    analysis_id: string;
    source_key: string;
    outcome: string;
    detail: string | null;
    cached: boolean;
    duration_ms: number;
  }>(
    `SELECT analysis_id, source_key, outcome::text AS outcome, detail, cached, duration_ms
       FROM source_calls WHERE analysis_id = ANY($1::uuid[]) ORDER BY created_at`,
    [ids],
  );
  return {
    analyses: analyses.rows.map((a) => ({
      id: a.id,
      status: a.status,
      createdAt: a.created_at,
      finishedAt: a.finished_at,
      reused: a.reused,
      resolveWaitedMs: a.resolve_waited_ms ?? 0,
      retried: a.retried,
      stale: a.stale,
      reusedOutputs: a.reused_outputs,
    })),
    steps: steps.rows.map((s) => ({
      analysisId: s.analysis_id,
      step: s.step,
      status: s.status,
      durationMs: s.duration_ms,
      reused: s.reused,
    })),
    llmCalls: llm.rows.map((c) => ({
      analysisId: c.analysis_id,
      purpose: c.purpose,
      model: c.model,
      outcome: c.outcome,
      inputTokens: c.input_tokens,
      outputTokens: c.output_tokens,
      latencyMs: c.latency_ms,
      waitedMs: c.waited_ms,
    })),
    sourceCalls: sources.rows.map((s) => ({
      analysisId: s.analysis_id,
      sourceKey: s.source_key,
      outcome: s.outcome,
      detail: s.detail,
      cached: s.cached,
      durationMs: s.duration_ms,
    })),
  };
}

const seconds = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const interval = (e: Estimate, fmt: (v: number | null) => string) =>
  e.low === null ? fmt(e.value) : `${fmt(e.value)} (${fmt(e.low)} to ${fmt(e.high)})`;
const usd = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(5)}`);
const whole = (v: number | null) => (v === null ? 'n/a' : Math.round(v).toLocaleString('en'));
const share = (r: Rate) =>
  r.value === null
    ? 'n/a'
    : `${r.hits} of ${r.n} (${r.value.toFixed(2)}, 95% interval ${r.low!.toFixed(2)} to ${r.high!.toFixed(2)})`;

/** The report as Markdown, for the README table (BE-16) and the session notes. */
export function renderReport(r: CostLatencyReport): string {
  const lines: string[] = [];
  lines.push('# Cost and latency (H4)', '');
  lines.push(`Window: ${r.window.since} to ${r.window.until}.`, '');
  lines.push(
    `Finished analyses: ${r.analyses.finished} (cold ${r.analyses.byKind.cold}, cached ${r.analyses.byKind.cached}, shared ${r.analyses.byKind.shared}); by status: ${Object.entries(
      r.analyses.byStatus,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ', ',
      )}. Left out of latency: ${r.analyses.excludedFromLatency.retried} retried, ${r.analyses.excludedFromLatency.stale} stale, ${r.analyses.excludedFromLatency.failed} failed.`,
    '',
  );
  lines.push('## Latency (server time, 95% bootstrap interval)', '');
  lines.push('| Request | n | p50 | p95 |', '|---|---|---|---|');
  for (const k of ['cold', 'cached', 'shared'] as const) {
    const l = r.latencyMs[k];
    lines.push(`| ${k} | ${l.n} | ${interval(l.p50, seconds)} | ${interval(l.p95, seconds)} |`);
  }
  const b = r.coldBreakdownMs;
  lines.push('', '## Cold analyses in detail', '');
  lines.push('| Part | p50 | p95 |', '|---|---|---|');
  lines.push(
    `| Model time | ${interval(b.modelTime.p50, seconds)} | ${interval(b.modelTime.p95, seconds)} |`,
  );
  lines.push(
    `| Pacing wait (free-tier caps) | ${interval(b.pacingWait.p50, seconds)} | ${interval(b.pacingWait.p95, seconds)} |`,
  );
  lines.push(
    `| Total without pacing wait | ${interval(b.withoutPacingWait.p50, seconds)} | ${interval(b.withoutPacingWait.p95, seconds)} |`,
  );
  lines.push('', '| Step | n | p50 | p95 |', '|---|---|---|---|');
  for (const [name, s] of Object.entries(b.steps)) {
    lines.push(`| ${name} | ${s.n} | ${seconds(s.p50)} | ${seconds(s.p95)} |`);
  }
  const t = r.tokensPerColdAnalysis;
  const c = r.costPerColdAnalysisUsd;
  lines.push('', '## Tokens and cost per cold analysis (mean, 95% bootstrap interval)', '');
  lines.push('| Measure | Value |', '|---|---|');
  lines.push(`| Cold builds measured | ${t.n} |`);
  lines.push(`| Model calls | ${interval(t.calls, (v) => (v === null ? 'n/a' : v.toFixed(2)))} |`);
  lines.push(`| Input tokens | ${interval(t.inputTokens, whole)} |`);
  lines.push(`| Output tokens | ${interval(t.outputTokens, whole)} |`);
  lines.push(`| Cost at list prices, models used | ${interval(c.measured, usd)} |`);
  lines.push(`| Same tokens at ${c.comparison.model} | ${interval(c.comparison, usd)} |`);
  lines.push(`| Saved per analysis by the small model | ${usd(c.savedPerAnalysis)} |`);
  if (c.unpricedModels.length > 0)
    lines.push(`| Models without a price | ${c.unpricedModels.join(', ')} |`);
  lines.push(
    '',
    'The free tier used for these runs costs nothing; prices are paid-tier list prices.',
  );
  lines.push('', '## Reuse', '');
  lines.push('| Measure | Value |', '|---|---|');
  lines.push(`| Analyses that reused a public reception | ${share(r.reuse.publicReception)} |`);
  lines.push(`| Source answers reused (PERF-1) | ${share(r.reuse.sourceAnswers)} |`);
  lines.push(`| Model outputs reused for unchanged evidence | ${r.reuse.modelOutputsReused} |`);
  lines.push(`| Public builds avoided | ${r.reuse.buildsAvoided} |`);
  lines.push(`| Model calls avoided (estimate) | ${whole(r.reuse.modelCallsAvoided)} |`);
  lines.push('', '## Model calls', '');
  lines.push(
    `${r.modelCalls.total} calls: ${
      Object.entries(r.modelCalls.byOutcome)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }. Invalid output: ${share(r.modelCalls.invalidOutput)}.`,
  );
  lines.push('', '## Sources', '');
  lines.push(
    '| Source | Answers | Reused | Asked | Outcomes | Asked p50 | Asked p95 |',
    '|---|---|---|---|---|---|---|',
  );
  for (const [key, s] of Object.entries(r.sources)) {
    const outcomes = Object.entries(s.outcomes)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const details = Object.entries(s.details)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    lines.push(
      `| ${key} | ${s.answers} | ${s.cached} | ${s.live} | ${outcomes}${details ? ` (${details})` : ''} | ${seconds(s.liveMs.p50)} | ${seconds(s.liveMs.p95)} |`,
    );
  }
  lines.push('', '## Method', '', ...r.method.map((m) => `- ${m}`));
  lines.push(
    '',
    `Seed ${r.params.seed}, ${r.params.resamples} bootstrap resamples, shared after ${r.params.sharedAfterMs} ms of waiting.`,
    '',
  );
  return lines.join('\n');
}
