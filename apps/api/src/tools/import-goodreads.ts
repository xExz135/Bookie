/**
 * Loads the UCSD Goodreads Book Graph into the database (BE-4).
 *
 *   pnpm --filter @bookie/api import:goodreads                     # everything
 *   pnpm --filter @bookie/api import:goodreads --limit-books 5000   # the 5,000 most-rated books
 *
 * Options:
 *   --data-dir <path>     folder with the five .json.gz files (default: <repo>/data/raw)
 *   --limit-books <n>     only the n most-rated books, with their works, authors, genres, reviews
 *   --min-ratings <n>     only books with at least n Goodreads ratings
 *   --skip-reviews        load the catalog only
 *
 * Safe to re-run: existing rows are kept and nothing is duplicated.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { loadConfig } from '../config/app-config';
import { GOODREADS_FILES, GoodreadsImporter } from '../catalog/goodreads/importer';
import { findRepoRoot } from '../repo-root';

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a whole number, got "${value}"`);
  return n;
}

async function main(): Promise<void> {
  const root = findRepoRoot();
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();

  // pnpm may pass a leading "--" separator through; ignore it.
  const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      'limit-books': { type: 'string' },
      'min-ratings': { type: 'string' },
      'skip-reviews': { type: 'boolean', default: false },
    },
  });
  const dataDir = values['data-dir'] ?? join(root, 'data', 'raw');
  const missing = Object.values(GOODREADS_FILES).filter((f) => !existsSync(join(dataDir, f)));
  if (missing.length > 0) {
    throw new Error(`Missing dataset files in ${dataDir}: ${missing.join(', ')}`);
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    const report = await new GoodreadsImporter(pool, {
      dataDir,
      limitBooks: positiveInt(values['limit-books'], '--limit-books'),
      minRatings: positiveInt(values['min-ratings'], '--min-ratings'),
      skipReviews: values['skip-reviews'],
      metadataTtlDays: config.CACHE_METADATA_TTL_DAYS,
      log: (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`),
    }).run();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
