/**
 * The cost and latency report (spec 9, H4, D-026) for the analyses created in
 * a time window, from what the pipeline recorded.
 *
 *   pnpm --filter @bookie/api metrics:report --since 2026-10-22T07:00:00Z
 *   pnpm --filter @bookie/api metrics:report --since 2026-10-22 --until 2026-10-23 --out eval/results/live
 *
 * Writes cost-latency.json and cost-latency.md to the output folder (default
 * eval/results/live) and prints the Markdown. The same rows always give the
 * same numbers (seeded bootstrap, REPORT_SEED).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import type { AppConfig } from '../config/app-config';
import {
  type CostLatencyReport,
  buildReport,
  loadReportRows,
  parsePrices,
  renderReport,
} from '../observability/cost-latency-report';
import { runCli, startCli } from './cli';

export function parseTime(value: string | undefined, name: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  const time = new Date(value);
  if (Number.isNaN(time.getTime()))
    throw new Error(`${name} must be a date or time, got "${value}"`);
  return time;
}

/** Builds the report for the window and writes it to `outDir`. */
export async function writeReport(
  config: AppConfig,
  window: { since: Date; until: Date },
  outDir: string,
  filter: { userIds?: string[] } = {},
): Promise<CostLatencyReport> {
  const db = new Client({ connectionString: config.DATABASE_URL });
  await db.connect();
  try {
    const rows = await loadReportRows(db, window, filter);
    const report = buildReport(rows, {
      window,
      prices: parsePrices(config.LLM_PRICES_USD_PER_MTOK),
      comparisonModel: config.COST_COMPARISON_MODEL,
      sharedAfterMs: config.PUBLIC_BUILD_WAIT_POLL_MS,
      resamples: config.REPORT_BOOTSTRAP_RESAMPLES,
      seed: config.REPORT_SEED,
    });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'cost-latency.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDir, 'cost-latency.md'), renderReport(report));
    return report;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  runCli(async () => {
    const { root, config, values } = startCli({
      since: { type: 'string' },
      until: { type: 'string' },
      out: { type: 'string' },
    });
    if (!values.since) throw new Error('Give --since, e.g. --since 2026-10-22T07:00:00Z');
    const window = {
      since: parseTime(values.since, '--since', new Date()),
      until: parseTime(values.until, '--until', new Date()),
    };
    const outDir = resolve(root, values.out ?? join('eval', 'results', 'live'));
    const report = await writeReport(config, window, outDir);
    console.log(renderReport(report));
    console.log(`Written to ${outDir}`);
  });
}
