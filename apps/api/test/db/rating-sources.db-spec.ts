import { Pool } from 'pg';
import { deterministicUuid } from '../../src/common/deterministic-id';
import { loadConfig } from '../../src/config/app-config';
import { PrismaService } from '../../src/database/prisma.service';
import type { BookRef, RatingLookup, RatingSourceAdapter } from '../../src/sources/rating-source';
import { RatingSourcesService } from '../../src/sources/rating-sources.service';
import { SourceError } from '../../src/sources/source-error';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-5: the service asks every permitted, configured source in parallel, each
 * within a deadline, and never turns a failure into "no ratings" (spec 8,
 * spec 11, RES-4). Adapters are fakes; policies come from the real
 * `review_sources` rows the migrations create.
 */
const id = (name: string) => deterministicUuid(`test:be5:${name}`);
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  SOURCE_DEADLINE_MS: '1000',
  CACHE_REVIEWS_TTL_DAYS: '30',
  CACHE_SOURCE_EMPTY_TTL_HOURS: '24',
  CACHE_SOURCE_FAILURE_TTL_MINUTES: '10',
});

let pool: Pool;
let prisma: PrismaService;

class FakeSource implements RatingSourceAdapter {
  readonly asked: BookRef[] = [];
  constructor(
    readonly key: string,
    private readonly answer: (signal: AbortSignal) => Promise<RatingLookup>,
    readonly configured = true,
  ) {}
  lookup(book: BookRef, signal: AbortSignal): Promise<RatingLookup> {
    this.asked.push(book);
    return this.answer(signal);
  }
}

const ok = (scope: 'work' | 'edition', cacheMaxAgeSeconds?: number | null): RatingLookup => ({
  outcome: 'ok',
  ratingAverage: 4.13,
  ratingCount: 7991,
  ratingScope: scope,
  externalId: 'x1',
  matchedBy: 'isbn',
  ...(cacheMaxAgeSeconds !== undefined ? { cacheMaxAgeSeconds } : {}),
});

const service = (adapters: RatingSourceAdapter[]) =>
  new RatingSourcesService(prisma, config, adapters);
const hours = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
  prisma = new PrismaService(config);
  await pool.query(
    `INSERT INTO works (id, title, created_at, updated_at) VALUES ($1, 'BE-5 work', now(), now())
     ON CONFLICT DO NOTHING`,
    [id('work')],
  );
  await pool.query(
    `INSERT INTO editions (id, work_id, title, subtitle, isbn_13, isbn_10, normalized_title,
       normalized_authors, metadata_expires_at, updated_at)
     VALUES ($1, $2, 'Cien años de soledad', NULL, '9788497592208', '8497592204', 'cien anos de soledad',
       'gabriel garcia marquez', now() + interval '1 day', now()) ON CONFLICT DO NOTHING`,
    [id('edition'), id('work')],
  );
  for (const [i, [name, role]] of [
    ['Gabriel García Márquez', null],
    ['Gregory Rabassa', 'Translator'],
  ].entries()) {
    await pool.query(
      `INSERT INTO authors (id, name, normalized_name) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING`,
      [id(`author${i}`), name],
    );
    await pool.query(
      `INSERT INTO edition_authors (edition_id, author_id, position, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [id('edition'), id(`author${i}`), i + 1, role],
    );
  }
  await pool.query(
    `INSERT INTO work_external_ids (work_id, source_id, external_id)
     VALUES ($1, (SELECT id FROM review_sources WHERE key = 'open_library'), 'OL274505W')
     ON CONFLICT DO NOTHING`,
    [id('work')],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

describe('Live rating sources (BE-5, D-003, D-020)', () => {
  it('has the audited policies for the three live sources (D-003)', async () => {
    const { rows } = await pool.query(
      `SELECT key, name, provides_text, storage_allowed, display_allowed, enabled
         FROM review_sources WHERE key IN ('open_library', 'google_books', 'hardcover') ORDER BY key`,
    );
    expect(rows).toEqual([
      {
        key: 'google_books',
        name: 'Google Books',
        provides_text: false,
        storage_allowed: false,
        display_allowed: true,
        enabled: true,
      },
      {
        key: 'hardcover',
        name: 'Hardcover',
        provides_text: false,
        storage_allowed: true,
        display_allowed: true,
        enabled: true,
      },
      {
        key: 'open_library',
        name: 'Open Library',
        provides_text: false,
        storage_allowed: true,
        display_allowed: true,
        enabled: true,
      },
    ]);
  });

  it('loads the book with main authors only, its ISBNs and the known Open Library work key', async () => {
    const book = await service([]).loadBook(id('edition'));
    expect(book).toEqual({
      editionId: id('edition'),
      title: 'Cien años de soledad',
      subtitle: null,
      authors: ['Gabriel García Márquez'],
      isbn13: '9788497592208',
      isbn10: '8497592204',
      openLibraryWorkKey: 'OL274505W',
    });
    await expect(service([]).lookupEdition(id('missing'))).resolves.toBeNull();
  });

  it('asks sources in parallel; one failing leaves the others intact (spec 11)', async () => {
    let inFlight = 0;
    let most = 0;
    const slow = (result: RatingLookup | Error) => async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight--;
      if (result instanceof Error) throw result;
      return result;
    };
    const results = await service([
      new FakeSource('open_library', slow(ok('work'))),
      new FakeSource('hardcover', slow(new SourceError('failed', 'Token refused', 'unauthorized'))),
      new FakeSource('google_books', slow({ outcome: 'empty', reason: 'not_found' })),
    ]).lookupEdition(id('edition'));

    expect(most).toBe(3);
    expect(results!.map((r) => [r.key, r.name, r.outcome, r.detail])).toEqual([
      ['open_library', 'Open Library', 'ok', null],
      ['hardcover', 'Hardcover', 'failed', 'unauthorized'],
      ['google_books', 'Google Books', 'empty', 'not_found'],
    ]);
    const [ol, hc, gb] = results!;
    expect(ol).toMatchObject({
      ratingAverage: 4.13,
      ratingCount: 7991,
      ratingScope: 'work',
      providesText: false,
    });
    // RES-4: a failure carries no numbers and is retried soon; it is not "no ratings".
    expect(hc).toMatchObject({ ratingAverage: null, ratingCount: null });
    expect(hours(hc!.fetchedAt, hc!.expiresAt)).toBeCloseTo(10 / 60, 3);
    expect(hours(gb!.fetchedAt, gb!.expiresAt)).toBeCloseTo(24, 3);
    expect(hours(ol!.fetchedAt, ol!.expiresAt)).toBeCloseTo(30 * 24, 3);
  });

  it('reports a source that misses its deadline as failed (timeout), even if it ignores the signal', async () => {
    const started = Date.now();
    const [result] = await service([
      new FakeSource('hardcover', () => new Promise<RatingLookup>(() => undefined)),
    ])
      .lookupEdition(id('edition'))
      .then((r) => r!);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ outcome: 'failed', detail: 'timeout' });
  });

  it('reports unexpected errors and rate limits as failures with their outcome', async () => {
    const results = await service([
      new FakeSource('open_library', async () => {
        throw new TypeError('bug');
      }),
      new FakeSource('hardcover', async () => {
        throw new SourceError('rate_limited', 'HTTP 429');
      }),
    ]).lookupEdition(id('edition'));
    expect(results!.map((r) => [r.outcome, r.detail])).toEqual([
      ['failed', 'internal'],
      ['rate_limited', 'rate_limited'],
    ]);
  });

  it('keeps Google Books ratings only as long as its cache header allows, and not at all without one', async () => {
    const [withHeader] = (await service([
      new FakeSource('google_books', async () => ok('edition', 600)),
    ]).lookupEdition(id('edition')))!;
    expect((withHeader!.expiresAt.getTime() - withHeader!.fetchedAt.getTime()) / 1000).toBe(600);
    expect(withHeader).toMatchObject({ storageAllowed: false, ratingScope: 'edition' });

    const [noHeader] = (await service([
      new FakeSource('google_books', async () => ok('edition', null)),
    ]).lookupEdition(id('edition')))!;
    expect(noHeader!.expiresAt.getTime()).toBe(noHeader!.fetchedAt.getTime());
  });

  it('does not ask a source that is not configured, disabled, or has no audited policy', async () => {
    const unconfigured = new FakeSource('hardcover', async () => ok('work'), false);
    const unaudited = new FakeSource('storygraph', async () => ok('work'));
    const disabled = new FakeSource('google_books', async () => ok('edition'));
    await pool.query(`UPDATE review_sources SET enabled = false WHERE key = 'google_books'`);
    try {
      const results = await service([unconfigured, unaudited, disabled]).lookupEdition(
        id('edition'),
      );
      expect(results).toEqual([]);
      expect([unconfigured.asked, unaudited.asked, disabled.asked]).toEqual([[], [], []]);
    } finally {
      await pool.query(`UPDATE review_sources SET enabled = true WHERE key = 'google_books'`);
    }
  });
});
