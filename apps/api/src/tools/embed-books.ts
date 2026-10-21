/**
 * Embeds catalog editions with Gemini and stores the vectors (BE-12).
 *
 *   pnpm --filter @bookie/api embed:books --limit 500
 *
 * Most popular editions first. Editions that already have a vector for the
 * current model key are skipped, so the command can be stopped and re-run.
 */
import { Pool } from 'pg';
import { BookEmbedder } from '../representation/book-embedder';
import { EditionEvidenceRepository } from '../representation/edition-evidence.repository';
import { geminiClient, selectionOptions } from '../representation/representation-config';
import { runCli, startCli, timestamp, wholeNumber } from './cli';

runCli(async () => {
  const { config, values } = startCli({ limit: { type: 'string' } });
  const limit = wholeNumber(values.limit, '--limit', 100);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    const embedder = new BookEmbedder(
      pool,
      new EditionEvidenceRepository(pool),
      geminiClient(config),
      {
        model: config.GEMINI_EMBEDDING_MODEL,
        batchSize: config.EMBEDDING_BATCH_SIZE,
        maxReviews: config.EMBEDDING_MAX_REVIEWS,
        maxChars: config.EMBEDDING_MAX_CHARS,
        candidateLimit: config.EVIDENCE_CANDIDATE_LIMIT,
        selection: selectionOptions(config, config.EMBEDDING_MAX_REVIEWS),
        log: (message) => console.log(`${timestamp()} ${message}`),
      },
    );
    const report = await embedder.embedMissing(limit);
    console.log(JSON.stringify(report, null, 2));
    if (report.stoppedBecause) process.exitCode = 2;
  } finally {
    await pool.end();
  }
});
