/**
 * Loads a taste-model release exported by `pnpm eval export` (BE-13, D-024).
 *
 *   pnpm --filter @bookie/api models:load                 # the newest folder in data/derived/models/
 *   pnpm --filter @bookie/api models:load --release 2026-10-21.3f9a12c0
 *   pnpm --filter @bookie/api models:load --no-ship       # load without serving it
 *
 * The release's shipped model then scores every new personal match; earlier
 * results keep the model version they were made with (MODEL-3).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadRelease } from '../taste-models/release-loader';
import { runCli, startCli, timestamp } from './cli';

runCli(async () => {
  const { root, config, values } = startCli({
    release: { type: 'string' },
    'no-ship': { type: 'boolean', default: false },
  });
  const base = join(root, 'data', 'derived', 'models');
  const version =
    values.release ??
    readdirSync(base)
      .filter((d) => /^\d{4}-\d{2}-\d{2}\.[0-9a-f]{8}$/.test(d))
      .sort()
      .at(-1);
  if (!version) throw new Error(`No release in ${base}. Run \`pnpm eval export\` first.`);
  const db = new Client({ connectionString: config.DATABASE_URL });
  await db.connect();
  try {
    console.log(`${timestamp()} Loading ${version}`);
    const report = await loadRelease(db, join(base, version), { ship: !values['no-ship'] });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.end();
  }
});
