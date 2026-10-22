/**
 * Measures real analyses for the cost and latency report (H4, D-026): real
 * Gemini, real live sources, the dev database.
 *
 *   pnpm --filter @bookie/api bench:analyses                  # 20 cold books, then the same 20 cached
 *   pnpm --filter @bookie/api bench:analyses --books 5 --gap-seconds 30
 *   pnpm --filter @bookie/api bench:analyses --no-cached
 *
 * A benchmark reader is created with the ratings of one dataset reader who
 * rated many of the shipped model's books, so the personal match runs as for
 * a real reader. Cold books are popular editions with dataset reviews, no
 * public analysis yet and no unexpired source answer, so nothing is reused.
 * They run one at a time, with a pause between them so each request meets
 * the free tier's per-minute caps as a single reader would; then each book
 * is analysed again, which reuses the public reception (cached). The report
 * covers exactly the analyses of this run and is written to eval/results/live.
 *
 * Uses the free Gemini quota (about two calls per cold book). Stops at the
 * first analysis that ran out of quota.
 */
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { AnalysisRunner } from '../analysis/analysis-runner';
import { AnalysisService } from '../analysis/analysis.service';
import { createApp } from '../app.factory';
import { AuthService } from '../auth/auth.service';
import { loadConfig } from '../config/app-config';
import { TasteService } from '../taste/taste.service';
import { renderReport } from '../observability/cost-latency-report';
import { writeReport } from './metrics-report';
import { runCli, startCli, timestamp, wholeNumber } from './cli';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

runCli(async () => {
  const { root, values } = startCli({
    books: { type: 'string' },
    'gap-seconds': { type: 'string' },
    ratings: { type: 'string' },
    'no-cached': { type: 'boolean', default: false },
    out: { type: 'string' },
  });
  const books = wholeNumber(values.books, '--books', 20);
  const gapMs = wholeNumber(values['gap-seconds'], '--gap-seconds', 45) * 1000;
  const ratingCount = wholeNumber(values.ratings, '--ratings', 20);
  // The benchmark reader's own requests must not hit the per-reader limits.
  const config = loadConfig({
    ...process.env,
    ANALYSIS_RECOVER_ON_START: 'false',
    RATE_LIMIT_ANALYSES_PER_HOUR: '100000',
    RATING_SAVES_PER_MINUTE: '100000',
  });
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in .env');

  const db = new Client({ connectionString: config.DATABASE_URL });
  await db.connect();
  const app = await createApp(config, { logger: ['warn', 'error'] });
  await app.init();
  const started = new Date();
  let userId = '';
  try {
    const analyses = app.get(AnalysisService);
    const runner = app.get(AnalysisRunner);

    // The benchmark reader, with one dataset reader's ratings of the shipped model's books.
    const stamp = started
      .toISOString()
      .replace(/[-:.TZ]/g, '')
      .slice(0, 14);
    const { session } = await app.get(AuthService).register({
      email: `bench-${stamp}@bookie.local`,
      password: randomBytes(24).toString('base64url'),
      displayName: `Benchmark ${stamp}`,
    });
    userId = session.user.id;
    const ratings = await db.query<{ edition_id: string; rating: number }>(
      `WITH shipped AS (SELECT id FROM model_versions WHERE is_shipped LIMIT 1),
            rated AS (
              SELECT r.reviewer_external_id AS reviewer, r.edition_id, r.rating
                FROM reviews r JOIN model_item_stats s ON s.edition_id = r.edition_id
               WHERE s.model_version_id = (SELECT id FROM shipped) AND r.rating IS NOT NULL
                 AND r.reviewer_external_id IS NOT NULL),
            reader AS (SELECT reviewer FROM rated GROUP BY reviewer
                        HAVING count(*) >= $1 ORDER BY count(*) DESC, reviewer LIMIT 1)
       SELECT edition_id, rating FROM rated WHERE reviewer = (SELECT reviewer FROM reader)
        ORDER BY edition_id LIMIT $1`,
      [ratingCount],
    );
    if (ratings.rows.length === 0) {
      throw new Error('No shipped model with rated books. Run `models:load` first.');
    }
    const taste = app.get(TasteService);
    for (const r of ratings.rows) await taste.setRating(userId, r.edition_id, r.rating);
    console.log(`${timestamp()} Benchmark reader with ${ratings.rows.length} rated books`);

    const cold = await db.query<{ id: string; title: string }>(
      `SELECT e.id, e.title
         FROM editions e
         LEFT JOIN review_fetches d ON d.edition_id = e.id AND d.reviews_version = 1
              AND d.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
        WHERE EXISTS (SELECT 1 FROM reviews r WHERE r.edition_id = e.id AND r.text IS NOT NULL
                        AND r.text_length >= $2)
          AND NOT EXISTS (SELECT 1 FROM public_analyses p WHERE p.edition_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM review_fetches f JOIN review_sources s ON s.id = f.source_id
                           WHERE f.edition_id = e.id AND s.key <> 'goodreads_dataset' AND f.expires_at > now())
          AND NOT (e.id = ANY($3::uuid[]))
        ORDER BY d.rating_count DESC NULLS LAST, e.id
        LIMIT $1`,
      [books, config.EVIDENCE_MIN_REVIEW_CHARS, ratings.rows.map((r) => r.edition_id)],
    );
    console.log(`${timestamp()} ${cold.rows.length} cold books; ${gapMs / 1000} s between them`);

    const run = async (editionId: string, title: string, label: string) => {
      const { analysis } = await analyses.start(userId, editionId);
      await runner.idle();
      const row = await db.query<{
        status: string;
        ms: number;
        codes: string[] | null;
        input: number | null;
        output: number | null;
      }>(
        `SELECT a.status::text AS status,
                (extract(epoch FROM a.finished_at - a.created_at) * 1000)::int AS ms,
                (SELECT array_agg(DISTINCT s.error_code) FROM analysis_steps s
                  WHERE s.analysis_id = a.id AND s.error_code IS NOT NULL) AS codes,
                (SELECT sum(input_tokens)::int FROM llm_calls c WHERE c.analysis_id = a.id) AS input,
                (SELECT sum(output_tokens)::int FROM llm_calls c WHERE c.analysis_id = a.id) AS output
           FROM analyses a WHERE a.id = $1`,
        [analysis.id],
      );
      const r = row.rows[0]!;
      const tokens = r.input === null ? 'no model call' : `${r.input} in, ${r.output} out`;
      console.log(
        `${timestamp()} ${label} ${title.slice(0, 50)}: ${r.status} in ${(r.ms / 1000).toFixed(1)} s, ${tokens}${
          r.codes ? ` (${r.codes.join(', ')})` : ''
        }`,
      );
      return r.codes?.includes('LLM_QUOTA_EXHAUSTED') ?? false;
    };

    const done: Array<{ id: string; title: string }> = [];
    for (const [i, book] of cold.rows.entries()) {
      if (i > 0) await sleep(gapMs);
      const quota = await run(book.id, book.title, `cold ${i + 1}/${cold.rows.length}`);
      done.push(book);
      if (quota) {
        console.log(`${timestamp()} The model quota is used up: stopping the cold run here.`);
        break;
      }
    }
    if (!values['no-cached']) {
      for (const [i, book] of done.entries()) {
        await run(book.id, book.title, `cached ${i + 1}/${done.length}`);
      }
    }
  } finally {
    await app.close();
    await db.end();
  }

  const outDir = resolve(root, values.out ?? join('eval', 'results', 'live'));
  // Only the benchmark reader's analyses: anything else running meanwhile is left out.
  const report = await writeReport(config, { since: started, until: new Date() }, outDir, {
    userIds: [userId],
  });
  console.log(`\n${renderReport(report)}`);
  console.log(
    `Written to ${outDir}. Run \`metrics:report --since ${started.toISOString()}\` to rebuild it.`,
  );
});
