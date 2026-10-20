import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Pool } from 'pg';
import {
  GOODREADS_FILES,
  GoodreadsImporter,
  type ImportReport,
} from '../../src/catalog/goodreads/importer';
import { ids } from '../../src/catalog/goodreads/parse';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-4: imports small made-up files shaped like the UCSD Goodreads dataset.
 * No real dataset content is stored in the repository (D-004).
 * IDs start with "imp-" so they never clash with other test files.
 */
const books = [
  {
    book_id: 'imp-b1',
    work_id: 'imp-w1',
    // Like the real dataset: title_without_series still holds the series marker.
    title: 'Señal (Series, #1)',
    title_without_series: 'Señal (Series, #1)',
    authors: [
      { author_id: 'imp-a1', role: '' },
      { author_id: 'imp-a-missing', role: '' },
    ],
    language_code: 'spa',
    publisher: 'Prensa',
    publication_year: '2011',
    format: 'Paperback',
    num_pages: '210',
    isbn: '0312853122',
    isbn13: '9780312853129',
    image_url: 'https://images.example/b1.jpg',
    description: 'A book.',
    average_rating: '4.20',
    ratings_count: '900',
  },
  {
    // Its work is not in the works file: a placeholder work is made.
    book_id: 'imp-b2',
    work_id: 'imp-w-missing',
    title: 'Second',
    title_without_series: 'Second',
    authors: [{ author_id: 'imp-a2', role: '' }],
    language_code: '',
    publication_year: '',
    image_url: 'https://s.gr-assets.com/assets/nophoto/book/111x148.png',
    average_rating: '3.10',
    ratings_count: '40',
  },
  {
    book_id: 'imp-b3',
    work_id: 'imp-w3',
    title: 'Unrated',
    title_without_series: 'Unrated',
    authors: [{ author_id: 'imp-a2', role: '' }],
    average_rating: '0.00',
    ratings_count: '0',
  },
  { book_id: 'imp-b4', title: '', title_without_series: '' }, // No title: skipped.
];
const authors = [
  { author_id: 'imp-a1', name: 'Ana Núñez' },
  { author_id: 'imp-a2', name: 'Bo Li' },
  { author_id: 'imp-a-unused', name: 'Nobody Used' },
];
const works = [
  { work_id: 'imp-w1', original_title: 'Señal', original_publication_year: '2010' },
  { work_id: 'imp-w3', original_title: 'Unrated', original_publication_year: '' },
  { work_id: 'imp-w-unused', original_title: 'Unused work' },
];
const genres = [
  { book_id: 'imp-b1', genres: { fiction: 12, 'not a dataset genre': 3 } },
  { book_id: 'imp-b2', genres: { 'mystery, thriller, crime': 4 } },
];
const reviews = [
  {
    review_id: 'imp-r1',
    book_id: 'imp-b1',
    user_id: 'u1',
    rating: 5,
    review_text: 'Wonderful.',
    date_added: 'Fri Aug 25 13:55:02 -0700 2017',
  },
  {
    review_id: 'imp-r2',
    book_id: 'imp-b1',
    user_id: 'u2',
    rating: 0,
    review_text: 'No stars, some words.',
    date_added: '',
  },
  {
    review_id: 'imp-r3',
    book_id: 'imp-b1',
    user_id: 'u3',
    rating: 2,
    review_text: '',
    date_added: '',
  },
  {
    review_id: 'imp-r4',
    book_id: 'imp-b1',
    user_id: 'u4',
    rating: 0,
    review_text: '   ',
    date_added: '',
  }, // Skipped.
  {
    review_id: 'imp-r5',
    book_id: 'imp-b-unknown',
    user_id: 'u5',
    rating: 4,
    review_text: 'Orphan.',
    date_added: '',
  },
  {
    review_id: 'imp-r6',
    book_id: 'imp-b2',
    user_id: 'u6',
    rating: 3,
    review_text: 'Fine.',
    date_added: '',
  },
];

let dataDir: string;
let pool: Pool;

function writeDataset(dir: string): void {
  const files: Record<keyof typeof GOODREADS_FILES, object[]> = {
    books,
    authors,
    works,
    genres,
    reviews,
  };
  for (const [name, rows] of Object.entries(files)) {
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(join(dir, GOODREADS_FILES[name as keyof typeof GOODREADS_FILES]), gzipSync(text));
  }
}

async function runImport(
  extra: { limitBooks?: number; minRatings?: number } = {},
): Promise<ImportReport> {
  return new GoodreadsImporter(pool, {
    dataDir,
    metadataTtlDays: 60,
    batchSize: 2,
    ...extra,
  }).run();
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pool.query(sql, params);
  return result.rows[0] as T;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bookie-goodreads-'));
  writeDataset(dataDir);
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('BE-4: Goodreads catalog import', () => {
  let first: ImportReport;

  beforeAll(async () => {
    first = await runImport();
  });

  it('reports what it read, inserted and skipped', () => {
    expect(first.books).toMatchObject({ read: 4, inserted: 3, skipped: 1, ratingSummaries: 2 });
    expect(first.works).toMatchObject({ inserted: 4, placeholders: 1 });
    expect(first.authors).toMatchObject({ read: 3, inserted: 3 });
    expect(first.genres.inserted).toBe(2);
    // r4 has neither rating nor text; r5's book is not in the catalog.
    expect(first.reviews).toMatchObject({ read: 6, skipped: 1, inserted: 4 });
  });

  it('maps an edition with its work, authors and external ID', async () => {
    const edition = await one<Record<string, unknown>>(
      `SELECT e.title, e.language, e.publisher, e.publication_year, e.page_count, e.isbn_10, e.isbn_13,
              e.cover_url, e.normalized_title, e.normalized_authors, w.title AS work_title,
              x.external_id, e.metadata_expires_at > now() + interval '59 days' AS expires_later
       FROM editions e JOIN works w ON w.id = e.work_id
       JOIN edition_external_ids x ON x.edition_id = e.id
       WHERE e.id = $1`,
      [ids.book('imp-b1')],
    );
    expect(edition).toEqual({
      title: 'Señal',
      language: 'es',
      publisher: 'Prensa',
      publication_year: 2011,
      page_count: 210,
      isbn_10: '0312853122',
      isbn_13: '9780312853129',
      cover_url: 'https://images.example/b1.jpg',
      normalized_title: 'senal',
      normalized_authors: 'ana nunez',
      work_title: 'Señal',
      external_id: 'imp-b1',
      expires_later: true,
    });
    // The link to an author missing from the authors file is dropped.
    const links = await pool.query('SELECT author_id FROM edition_authors WHERE edition_id = $1', [
      ids.book('imp-b1'),
    ]);
    expect(links.rows).toEqual([{ author_id: ids.author('imp-a1') }]);
  });

  it("makes a placeholder work when the book's work is missing", async () => {
    const row = await one<{
      work_id: string;
      title: string;
      cover_url: string | null;
      language: string | null;
    }>(
      `SELECT e.work_id, w.title, e.cover_url, e.language FROM editions e JOIN works w ON w.id = e.work_id WHERE e.id = $1`,
      [ids.book('imp-b2')],
    );
    expect(row).toEqual({
      work_id: ids.placeholderWork('imp-b2'),
      title: 'Second',
      cover_url: null,
      language: null,
    });
  });

  it('keeps only dataset genres', async () => {
    const rows = await pool.query(
      `SELECT g.name, eg.votes FROM edition_genres eg JOIN genres g ON g.id = eg.genre_id WHERE eg.edition_id = $1`,
      [ids.book('imp-b1')],
    );
    expect(rows.rows).toEqual([{ name: 'fiction', votes: 12 }]);
  });

  it('stores reviews with rating 0 as "no rating" and rating-only reviews with empty text', async () => {
    const rows = await pool.query(
      `SELECT external_review_id, rating, text, text_length FROM reviews WHERE edition_id = $1 ORDER BY external_review_id`,
      [ids.book('imp-b1')],
    );
    expect(rows.rows).toEqual([
      { external_review_id: 'imp-r1', rating: 5, text: 'Wonderful.', text_length: 10 },
      {
        external_review_id: 'imp-r2',
        rating: null,
        text: 'No stars, some words.',
        text_length: 21,
      },
      { external_review_id: 'imp-r3', rating: 2, text: '', text_length: 0 },
    ]);
  });

  it("stores Goodreads' rating summary as a dataset fetch with the review count", async () => {
    const row = await one<Record<string, unknown>>(
      `SELECT f.outcome, f.rating_average::text AS average, f.rating_count, f.review_count, s.key
       FROM review_fetches f JOIN review_sources s ON s.id = f.source_id WHERE f.edition_id = $1`,
      [ids.book('imp-b1')],
    );
    expect(row).toEqual({
      outcome: 'ok',
      average: '4.20',
      rating_count: 900,
      review_count: 3,
      key: 'goodreads_dataset',
    });
    const unrated = await pool.query('SELECT 1 FROM review_fetches WHERE edition_id = $1', [
      ids.book('imp-b3'),
    ]);
    expect(unrated.rowCount).toBe(0);
  });

  it('can be re-run without duplicating or changing anything', async () => {
    const again = await runImport();
    expect(again.books).toMatchObject({ inserted: 0, updated: 0 });
    expect(again.works).toMatchObject({ inserted: 0, updated: 0 });
    expect(again.authors.inserted).toBe(0);
    expect(again.genres.inserted).toBe(0);
    expect(again.reviews.inserted).toBe(0);
    const { n } = await one<{ n: string }>(
      `SELECT count(*) AS n FROM reviews WHERE external_review_id LIKE 'imp-r%'`,
    );
    expect(Number(n)).toBe(4);
  });

  it('updates an edition whose details changed since the last run', async () => {
    const changed = books.map((b) =>
      b.book_id === 'imp-b1' ? { ...b, publisher: 'New Press' } : b,
    );
    writeFileSync(
      join(dataDir, GOODREADS_FILES.books),
      gzipSync(changed.map((b) => JSON.stringify(b)).join('\n') + '\n'),
    );
    try {
      const report = await runImport();
      expect(report.books).toMatchObject({ inserted: 0, updated: 1 });
      const { publisher } = await one<{ publisher: string }>(
        'SELECT publisher FROM editions WHERE id = $1',
        [ids.book('imp-b1')],
      );
      expect(publisher).toBe('New Press');
    } finally {
      writeDataset(dataDir);
    }
  });
});

describe('BE-4: subset import', () => {
  it('imports only the most-rated books and what they need', async () => {
    // Fresh data with different IDs so the full import above does not interfere.
    const subsetDir = mkdtempSync(join(tmpdir(), 'bookie-goodreads-subset-'));
    const rename = (value: unknown): unknown =>
      typeof value === 'string' ? value.replace(/^imp-/, 'sub-') : value;
    const renameRow = (row: object): object =>
      JSON.parse(JSON.stringify(row), (key, value) =>
        ['book_id', 'work_id', 'author_id', 'review_id'].includes(key) ? rename(value) : value,
      );
    const files: Record<keyof typeof GOODREADS_FILES, object[]> = {
      books: books.map(renameRow),
      authors: authors.map(renameRow),
      works: works.map(renameRow),
      genres: genres.map(renameRow),
      reviews: reviews.map(renameRow),
    };
    for (const [name, rows] of Object.entries(files)) {
      writeFileSync(
        join(subsetDir, GOODREADS_FILES[name as keyof typeof GOODREADS_FILES]),
        gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
      );
    }
    try {
      const report = await new GoodreadsImporter(pool, {
        dataDir: subsetDir,
        metadataTtlDays: 60,
        limitBooks: 1,
        minRatings: 100,
      }).run();
      expect(report.selection).toEqual({ mode: 'subset', selectedBooks: 1 });
      expect(report.books.inserted).toBe(1);
      expect(report.works).toMatchObject({ inserted: 1, placeholders: 0 });
      expect(report.authors.inserted).toBe(1); // Only sub-a1 is needed.
      expect(report.reviews.inserted).toBe(3);
      expect(report.reviews.notSelected).toBe(2);
      const editions = await pool.query(
        `SELECT x.external_id FROM edition_external_ids x WHERE x.external_id LIKE 'sub-%'`,
      );
      expect(editions.rows).toEqual([{ external_id: 'sub-b1' }]);
    } finally {
      rmSync(subsetDir, { recursive: true, force: true });
    }
  });
});
