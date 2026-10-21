import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONTRACT_ENUMS } from '../contract/enums';

/**
 * Loads a release exported by `pnpm eval export` (D-006, D-024) into the
 * database: one `model_versions` row per model (B0 to B4) with its parameters
 * and its validation and test results (EVAL-2), the books the population
 * models know with their item offsets (B0, B3), and B3's similarities.
 *
 * The files are checked against the checksums in release.json, every book must
 * be in the catalog, and loading is one transaction. Loading a version that is
 * already there changes nothing (scores may already point at it).
 */

const metricSummary = z.object({
  value: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  readers: z.number(),
});
const splitMetrics = z.object({ spearman: metricSummary, ndcg: metricSummary, mae: metricSummary });

export const releaseSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.[0-9a-f]{8}$/),
  shipped: z.enum(CONTRACT_ENUMS.modelId),
  selection: z.string(),
  seed: z.number().int(),
  snapshotChecksum: z.string(),
  harnessChecksum: z.string(),
  books: z.number().int().positive(),
  neighbourPairs: z.number().int().min(0),
  models: z.object({
    B0: z.object({
      parameters: z.object({ globalMean: z.number() }),
      metrics: z.object({ validation: splitMetrics, test: splitMetrics }),
    }),
    B1: z.object({
      parameters: z.object({
        weightGenre: z.number(),
        weightPace: z.number(),
        weightThemeAvoid: z.number(),
        genreShare: z.number(),
        genreNames: z.array(z.string()),
        sensitivityWeights: z.record(z.string(), z.number()),
        themeMap: z.record(z.string(), z.string()),
      }),
      metrics: z.object({ validation: splitMetrics, test: splitMetrics }),
    }),
    B2: z.object({
      parameters: z.object({
        intercept: z.number(),
        readerMean: z.number(),
        cosine: z.number(),
        embeddingModel: z.string(),
      }),
      metrics: z.object({ validation: splitMetrics, test: splitMetrics }),
    }),
    B3: z.object({
      parameters: z.object({
        globalMean: z.number(),
        readerShrinkage: z.number(),
        neighbours: z.number().int().positive(),
        weightDamping: z.number().min(0),
      }),
      metrics: z.object({ validation: splitMetrics, test: splitMetrics }),
    }),
    B4: z.object({
      parameters: z.object({ intercept: z.number(), b2: z.number(), b3: z.number() }),
      metrics: z.object({ validation: splitMetrics, test: splitMetrics }),
    }),
  }),
  files: z.object({ 'item_bias.csv': z.string(), 'neighbours.csv': z.string() }),
});
export type Release = z.infer<typeof releaseSchema>;

export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface LoadReport {
  version: string;
  shipped: string;
  alreadyLoaded: boolean;
  books: number;
  neighbourPairs: number;
  madeShipped: boolean;
}

const MODELS = ['B0', 'B1', 'B2', 'B3', 'B4'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function csvRows(text: string, header: string): string[][] {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines[0] !== header) throw new Error(`Expected the header "${header}", got "${lines[0]}"`);
  return lines.slice(1).map((l) => l.split(','));
}

function number(value: string | undefined, what: string): number {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n))
    throw new Error(`${what} is not a number: ${value}`);
  return n;
}

function id(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) throw new Error(`${what} is not an edition id: ${value}`);
  return value;
}

/** Reads and checks a release folder without touching the database. */
export function readRelease(folder: string) {
  const releaseBytes = readFileSync(join(folder, 'release.json'));
  const release = releaseSchema.parse(JSON.parse(releaseBytes.toString('utf8')));
  const read = (name: keyof Release['files']) => {
    const bytes = readFileSync(join(folder, name));
    if (sha256(bytes) !== release.files[name])
      throw new Error(`${name} does not match its checksum in release.json`);
    return bytes.toString('utf8');
  };
  const itemBias = csvRows(read('item_bias.csv'), 'edition_id,item_bias').map(([e, b]) => ({
    editionId: id(e, 'item_bias.csv'),
    itemBias: number(b, 'item_bias'),
  }));
  const neighbours = csvRows(read('neighbours.csv'), 'edition_id,neighbour_id,similarity').map(
    ([e, n, s]) => ({
      editionId: id(e, 'neighbours.csv'),
      neighbourId: id(n, 'neighbours.csv'),
      similarity: number(s, 'similarity'),
    }),
  );
  if (itemBias.length !== release.books) throw new Error('item_bias.csv does not list every book');
  if (neighbours.length !== release.neighbourPairs)
    throw new Error('neighbours.csv does not list every pair');
  if (neighbours.some((n) => n.similarity <= 0)) throw new Error('similarities must be above 0');
  return { release, itemBias, neighbours, checksum: sha256(releaseBytes) };
}

/** Loads a release in one transaction; with `ship`, its shipped model becomes the one served. */
export async function loadRelease(
  db: Queryable,
  folder: string,
  options: { ship: boolean },
): Promise<LoadReport> {
  const { release, itemBias, neighbours, checksum } = readRelease(folder);
  const report: LoadReport = {
    version: release.version,
    shipped: release.shipped,
    alreadyLoaded: false,
    books: itemBias.length,
    neighbourPairs: neighbours.length,
    madeShipped: false,
  };

  await db.query('BEGIN');
  try {
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM model_versions WHERE version = $1',
      [release.version],
    );
    if (existing.rows.length > 0) {
      report.alreadyLoaded = true;
    } else {
      const ids = [...new Set(itemBias.map((i) => i.editionId))];
      const found = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM editions WHERE id = ANY($1::uuid[])',
        [ids],
      );
      if (found.rows[0]!.n !== ids.length)
        throw new Error(
          `${ids.length - found.rows[0]!.n} books of the release are not in the catalog`,
        );

      const rowId: Record<string, string> = {};
      for (const model of MODELS) {
        const r = await db.query<{ id: string }>(
          `INSERT INTO model_versions (id, model_id, version, artifact_checksum, seed, trained_at, metrics, parameters, is_shipped)
           VALUES (gen_random_uuid(), $1::model_id, $2, $3, $4, now(), $5::jsonb, $6::jsonb, false) RETURNING id`,
          [
            model,
            release.version,
            checksum,
            release.seed,
            JSON.stringify(release.models[model].metrics),
            JSON.stringify({
              ...release.models[model].parameters,
              release: {
                shipped: release.shipped,
                books: release.books,
                selection: release.selection,
                snapshotChecksum: release.snapshotChecksum,
                harnessChecksum: release.harnessChecksum,
              },
            }),
          ],
        );
        rowId[model] = r.rows[0]!.id;
      }
      // B0 and B3 both read the item offsets; B3 reads the similarities.
      for (const model of ['B0', 'B3'] as const) {
        await db.query(
          `INSERT INTO model_item_stats (model_version_id, edition_id, item_bias)
           SELECT $1::uuid, e, b FROM unnest($2::uuid[], $3::float8[]) AS t(e, b)`,
          [rowId[model], itemBias.map((i) => i.editionId), itemBias.map((i) => i.itemBias)],
        );
      }
      const chunk = 20_000;
      for (let i = 0; i < neighbours.length; i += chunk) {
        const part = neighbours.slice(i, i + chunk);
        await db.query(
          `INSERT INTO model_item_neighbours (model_version_id, edition_id, neighbour_id, similarity)
           SELECT $1::uuid, e, n, s FROM unnest($2::uuid[], $3::uuid[], $4::float8[]) AS t(e, n, s)`,
          [
            rowId.B3,
            part.map((p) => p.editionId),
            part.map((p) => p.neighbourId),
            part.map((p) => p.similarity),
          ],
        );
      }
    }
    if (options.ship) {
      await db.query('UPDATE model_versions SET is_shipped = false WHERE is_shipped');
      await db.query(
        'UPDATE model_versions SET is_shipped = true WHERE version = $1 AND model_id = $2::model_id',
        [release.version, release.shipped],
      );
      report.madeShipped = true;
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  return report;
}
