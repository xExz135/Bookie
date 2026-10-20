import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { normalizeForSearch } from '../normalize';
import { StagedBatch, readJsonLines } from './io';
import {
  ids,
  parseAuthor,
  parseBook,
  parseGenres,
  parseReview,
  parseWork,
  type RawAuthor,
  type RawBook,
  type RawGenres,
  type RawReview,
  type RawWork,
  type WorkRow,
} from './parse';

/** The five dataset files (D-004), as named in data/raw/. */
export const GOODREADS_FILES = {
  books: 'goodreads_books.json.gz',
  authors: 'goodreads_book_authors.json.gz',
  works: 'goodreads_book_works.json.gz',
  genres: 'goodreads_book_genres_initial.json.gz',
  reviews: 'goodreads_reviews_dedup.json.gz',
} as const;

export const DATASET_SOURCE_KEY = 'goodreads_dataset';

export interface ImportOptions {
  dataDir: string;
  /** Import only the N most-rated books (with their works, authors, genres, reviews). */
  limitBooks?: number;
  /** Import only books with at least this many Goodreads ratings. */
  minRatings?: number;
  skipReviews?: boolean;
  /** Edition metadata reuse window (CACHE_METADATA_TTL_DAYS). */
  metadataTtlDays: number;
  batchSize?: number;
  log?: (message: string) => void;
}

interface StepCounts {
  read: number;
  inserted: number;
  skipped: number;
}

export interface ImportReport {
  selection: { mode: 'all' | 'subset'; selectedBooks: number | null };
  authors: StepCounts;
  works: StepCounts & { updated: number; placeholders: number };
  books: StepCounts & { updated: number; authorLinks: number; ratingSummaries: number };
  genres: StepCounts;
  reviews: StepCounts & { notSelected: number };
  durationMs: number;
}

const counts = (): StepCounts => ({ read: 0, inserted: 0, skipped: 0 });

/**
 * Loads the UCSD Goodreads Book Graph into the catalog (BE-4).
 * Every row's ID is derived from its Goodreads ID, so re-running the import
 * never duplicates rows. A re-run updates editions and works whose details
 * changed (for example after an import fix) and leaves everything else alone.
 */
export class GoodreadsImporter {
  private client!: PoolClient;
  private sourceId!: number;
  private readonly batchSize: number;
  private readonly log: (message: string) => void;

  /** Null = all books. */
  private selected: Set<string> | null = null;
  private neededWorks: Set<string> | null = null;
  private neededAuthors: Set<string> | null = null;
  private readonly importedWorks = new Set<string>();
  private readonly authorNames = new Map<string, string>();

  constructor(
    private readonly pool: Pool,
    private readonly options: ImportOptions,
  ) {
    this.batchSize = options.batchSize ?? 20_000;
    this.log = options.log ?? (() => undefined);
  }

  async run(): Promise<ImportReport> {
    const started = Date.now();
    this.client = await this.pool.connect();
    try {
      this.sourceId = await this.datasetSourceId();
      await this.createStagingTables();

      const report: ImportReport = {
        selection: { mode: 'all', selectedBooks: null },
        authors: counts(),
        works: { ...counts(), updated: 0, placeholders: 0 },
        books: { ...counts(), updated: 0, authorLinks: 0, ratingSummaries: 0 },
        genres: counts(),
        reviews: { ...counts(), notSelected: 0 },
        durationMs: 0,
      };

      if (this.options.limitBooks !== undefined || this.options.minRatings !== undefined) {
        await this.selectBooks();
        report.selection = { mode: 'subset', selectedBooks: this.selected!.size };
      }
      await this.importAuthors(report.authors);
      await this.importWorks(report.works);
      await this.importBooks(report.books, report.works);
      await this.importGenres(report.genres);
      if (!this.options.skipReviews) {
        await this.importReviews(report.reviews);
        await this.updateReviewCounts();
      }
      await this.client.query(
        'ANALYZE authors, works, editions, edition_authors, edition_genres, reviews, review_fetches',
      );
      report.durationMs = Date.now() - started;
      return report;
    } finally {
      this.client.release();
    }
  }

  private file(name: keyof typeof GOODREADS_FILES): string {
    return join(this.options.dataDir, GOODREADS_FILES[name]);
  }

  private progress(step: string, read: number): void {
    if (read % 250_000 === 0) this.log(`${step}: ${read.toLocaleString('en')} records read`);
  }

  private async datasetSourceId(): Promise<number> {
    const result = await this.client.query<{ id: number }>(
      'SELECT id FROM review_sources WHERE key = $1',
      [DATASET_SOURCE_KEY],
    );
    const row = result.rows[0];
    if (!row)
      throw new Error(`Source "${DATASET_SOURCE_KEY}" is missing. Run the migrations first.`);
    return row.id;
  }

  private async createStagingTables(): Promise<void> {
    // Temporary tables live only for this connection and vanish afterwards.
    await this.client.query(`
      CREATE TEMP TABLE IF NOT EXISTS stage_authors (id uuid, external_id text, name text, normalized_name text);
      CREATE TEMP TABLE IF NOT EXISTS stage_works (id uuid, external_id text, title text, original_publication_year int);
      CREATE TEMP TABLE IF NOT EXISTS stage_editions (
        id uuid, work_id uuid, external_id text, title text, language text, publisher text,
        publication_year int, format text, page_count int, isbn_10 text, isbn_13 text,
        cover_url text, description text, normalized_title text, normalized_authors text);
      CREATE TEMP TABLE IF NOT EXISTS stage_edition_authors (edition_id uuid, author_id uuid, position int, role text);
      CREATE TEMP TABLE IF NOT EXISTS stage_rating_summaries (id uuid, edition_id uuid, rating_average numeric(3,2), rating_count int);
      CREATE TEMP TABLE IF NOT EXISTS stage_edition_genres (edition_id uuid, genre_name text, votes int);
      CREATE TEMP TABLE IF NOT EXISTS stage_reviews (
        id uuid, edition_id uuid, external_review_id text, reviewer_external_id text,
        rating smallint, text text, text_length int, posted_at timestamptz);
    `);
  }

  private async insert(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.client.query(sql, params);
    return result.rowCount ?? 0;
  }

  /** Runs an upsert ending in RETURNING (xmax = 0) AS inserted; counts inserts and updates. */
  private async upsert(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ inserted: number; updated: number }> {
    const result = await this.client.query<{ inserted: boolean }>(sql, params);
    const inserted = result.rows.filter((row) => row.inserted).length;
    return { inserted, updated: result.rows.length - inserted };
  }

  /** Subset mode: picks the most-rated books, then what they need. */
  private async selectBooks(): Promise<void> {
    const minRatings = this.options.minRatings ?? 0;
    const candidates: Array<[number, string]> = [];
    let read = 0;
    for await (const raw of readJsonLines<RawBook>(this.file('books'))) {
      this.progress('Selecting books', ++read);
      const ratings = Number.parseInt(raw.ratings_count ?? '0', 10) || 0;
      if (raw.book_id && ratings >= minRatings) candidates.push([ratings, raw.book_id]);
    }
    // Most-rated first; ties broken by ID so the subset is the same every run.
    candidates.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    const chosen = candidates.slice(0, this.options.limitBooks ?? candidates.length);
    this.selected = new Set(chosen.map(([, id]) => id));
    this.log(`Selected ${this.selected.size.toLocaleString('en')} books`);

    this.neededWorks = new Set();
    this.neededAuthors = new Set();
    for await (const raw of readJsonLines<RawBook>(this.file('books'))) {
      if (!raw.book_id || !this.selected.has(raw.book_id)) continue;
      if (raw.work_id) this.neededWorks.add(raw.work_id);
      for (const author of raw.authors ?? [])
        if (author.author_id) this.neededAuthors.add(author.author_id);
    }
  }

  private async importAuthors(step: StepCounts): Promise<void> {
    const batch = new StagedBatch(
      this.client,
      'stage_authors',
      ['id', 'external_id', 'name', 'normalized_name'],
      this.batchSize,
    );
    const flush = async () => {
      await batch.load();
      step.inserted += await this.insert(
        `INSERT INTO authors (id, name, normalized_name)
         SELECT id, name, normalized_name FROM stage_authors ON CONFLICT DO NOTHING`,
      );
      await this.insert(
        `INSERT INTO author_external_ids (author_id, source_id, external_id)
         SELECT id, $1, external_id FROM stage_authors ON CONFLICT DO NOTHING`,
        [this.sourceId],
      );
      await batch.truncate();
    };
    for await (const raw of readJsonLines<RawAuthor>(this.file('authors'))) {
      this.progress('Authors', ++step.read);
      const author = parseAuthor(raw);
      if (!author || (this.neededAuthors && !this.neededAuthors.has(author.externalId))) {
        step.skipped++;
        continue;
      }
      this.authorNames.set(author.externalId, author.name);
      if (batch.push([author.id, author.externalId, author.name, author.normalizedName]))
        await flush();
    }
    await flush();
    this.log(`Authors: ${step.inserted.toLocaleString('en')} inserted`);
  }

  private worksBatch(): StagedBatch {
    return new StagedBatch(
      this.client,
      'stage_works',
      ['id', 'external_id', 'title', 'original_publication_year'],
      this.batchSize,
    );
  }

  private async flushWorks(batch: StagedBatch): Promise<{ inserted: number; updated: number }> {
    if ((await batch.load()) === 0) return { inserted: 0, updated: 0 };
    const result = await this.upsert(
      `INSERT INTO works (id, title, original_publication_year, created_at, updated_at)
       SELECT id, title, original_publication_year, now(), now() FROM stage_works
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         original_publication_year = EXCLUDED.original_publication_year,
         updated_at = now()
       WHERE (works.title, works.original_publication_year)
         IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.original_publication_year)
       RETURNING (xmax = 0) AS inserted`,
    );
    await this.insert(
      `INSERT INTO work_external_ids (work_id, source_id, external_id)
       SELECT id, $1, external_id FROM stage_works WHERE external_id IS NOT NULL ON CONFLICT DO NOTHING`,
      [this.sourceId],
    );
    await batch.truncate();
    return result;
  }

  private pushWork(batch: StagedBatch, work: WorkRow): boolean {
    return batch.push([work.id, work.externalId, work.title, work.originalPublicationYear]);
  }

  private async importWorks(step: ImportReport['works']): Promise<void> {
    const batch = this.worksBatch();
    for await (const raw of readJsonLines<RawWork>(this.file('works'))) {
      this.progress('Works', ++step.read);
      const work = parseWork(raw);
      if (!work || (this.neededWorks && !this.neededWorks.has(work.externalId!))) {
        step.skipped++;
        continue;
      }
      this.importedWorks.add(work.externalId!);
      if (this.pushWork(batch, work)) this.addWorks(step, await this.flushWorks(batch));
    }
    this.addWorks(step, await this.flushWorks(batch));
    this.log(
      `Works: ${step.inserted.toLocaleString('en')} inserted, ${step.updated.toLocaleString('en')} updated`,
    );
  }

  private addWorks(
    step: ImportReport['works'],
    result: { inserted: number; updated: number },
    placeholders = false,
  ): void {
    step.inserted += result.inserted;
    step.updated += result.updated;
    if (placeholders) step.placeholders += result.inserted;
  }

  private async importBooks(
    step: ImportReport['books'],
    workStep: ImportReport['works'],
  ): Promise<void> {
    const works = this.worksBatch();
    const editions = new StagedBatch(
      this.client,
      'stage_editions',
      [
        'id',
        'work_id',
        'external_id',
        'title',
        'language',
        'publisher',
        'publication_year',
        'format',
        'page_count',
        'isbn_10',
        'isbn_13',
        'cover_url',
        'description',
        'normalized_title',
        'normalized_authors',
      ],
      this.batchSize,
    );
    const links = new StagedBatch(
      this.client,
      'stage_edition_authors',
      ['edition_id', 'author_id', 'position', 'role'],
      Infinity,
    );
    const summaries = new StagedBatch(
      this.client,
      'stage_rating_summaries',
      ['id', 'edition_id', 'rating_average', 'rating_count'],
      Infinity,
    );

    const flush = async () => {
      // Placeholder works first: editions reference them.
      this.addWorks(workStep, await this.flushWorks(works), true);
      if ((await editions.load()) === 0) return;
      await links.load();
      await summaries.load();
      const editionResult = await this.upsert(
        `INSERT INTO editions (
           id, work_id, title, language, publisher, publication_year, format, page_count,
           isbn_10, isbn_13, cover_url, description, normalized_title, normalized_authors,
           metadata_fetched_at, metadata_expires_at, created_at, updated_at)
         SELECT id, work_id, title, language, publisher, publication_year, format, page_count,
           isbn_10, isbn_13, cover_url, description, normalized_title, normalized_authors,
           now(), now() + make_interval(days => $1), now(), now()
         FROM stage_editions
         ON CONFLICT (id) DO UPDATE SET
           (work_id, title, language, publisher, publication_year, format, page_count,
            isbn_10, isbn_13, cover_url, description, normalized_title, normalized_authors,
            metadata_fetched_at, metadata_expires_at, updated_at)
           = (EXCLUDED.work_id, EXCLUDED.title, EXCLUDED.language, EXCLUDED.publisher,
              EXCLUDED.publication_year, EXCLUDED.format, EXCLUDED.page_count, EXCLUDED.isbn_10,
              EXCLUDED.isbn_13, EXCLUDED.cover_url, EXCLUDED.description, EXCLUDED.normalized_title,
              EXCLUDED.normalized_authors, now(), EXCLUDED.metadata_expires_at, now())
         WHERE (editions.work_id, editions.title, editions.language, editions.publisher,
                editions.publication_year, editions.format, editions.page_count, editions.isbn_10,
                editions.isbn_13, editions.cover_url, editions.description,
                editions.normalized_title, editions.normalized_authors)
           IS DISTINCT FROM
               (EXCLUDED.work_id, EXCLUDED.title, EXCLUDED.language, EXCLUDED.publisher,
                EXCLUDED.publication_year, EXCLUDED.format, EXCLUDED.page_count, EXCLUDED.isbn_10,
                EXCLUDED.isbn_13, EXCLUDED.cover_url, EXCLUDED.description,
                EXCLUDED.normalized_title, EXCLUDED.normalized_authors)
         RETURNING (xmax = 0) AS inserted`,
        [this.options.metadataTtlDays],
      );
      step.inserted += editionResult.inserted;
      step.updated += editionResult.updated;
      await this.insert(
        `INSERT INTO edition_external_ids (edition_id, source_id, external_id)
         SELECT id, $1, external_id FROM stage_editions ON CONFLICT DO NOTHING`,
        [this.sourceId],
      );
      // Links to authors missing from the authors file are dropped.
      step.authorLinks += await this.insert(
        `INSERT INTO edition_authors (edition_id, author_id, position, role)
         SELECT s.edition_id, s.author_id, s.position, s.role
         FROM stage_edition_authors s JOIN authors a ON a.id = s.author_id ON CONFLICT DO NOTHING`,
      );
      // Goodreads' own rating summary for the edition, stored as a dataset
      // fetch that never expires (the dataset is a fixed snapshot).
      step.ratingSummaries += await this.insert(
        `INSERT INTO review_fetches (
           id, edition_id, source_id, reviews_version, outcome, rating_average, rating_count,
           fetched_at, expires_at)
         SELECT id, edition_id, $1, 1, 'ok', rating_average, rating_count, now(), '9999-12-31T00:00:00Z'
         FROM stage_rating_summaries ON CONFLICT DO NOTHING`,
        [this.sourceId],
      );
      // One query at a time: a pg client cannot run queries in parallel.
      await editions.truncate();
      await links.truncate();
      await summaries.truncate();
    };

    for await (const raw of readJsonLines<RawBook>(this.file('books'))) {
      this.progress('Books', ++step.read);
      if (this.selected && !(raw.book_id && this.selected.has(raw.book_id))) continue;
      const book = parseBook(raw);
      if (!book) {
        step.skipped++;
        continue;
      }
      let workId: string;
      if (book.workExternalId && this.importedWorks.has(book.workExternalId)) {
        workId = ids.work(book.workExternalId);
      } else {
        workId = ids.placeholderWork(book.externalId);
        this.pushWork(works, {
          id: workId,
          externalId: null,
          title: book.edition.title,
          originalPublicationYear: book.edition.publicationYear,
        });
      }
      const authorNames = book.authors
        .map((a) => this.authorNames.get(a.externalId))
        .filter((name): name is string => !!name);
      const e = book.edition;
      for (const author of book.authors) {
        links.push([e.id, ids.author(author.externalId), author.position, author.role]);
      }
      if (book.ratingSummary) {
        summaries.push([
          book.ratingSummary.id,
          e.id,
          book.ratingSummary.average,
          book.ratingSummary.count,
        ]);
      }
      const full = editions.push([
        e.id,
        workId,
        book.externalId,
        e.title,
        e.language,
        e.publisher,
        e.publicationYear,
        e.format,
        e.pageCount,
        e.isbn10,
        e.isbn13,
        e.coverUrl,
        e.description,
        e.normalizedTitle,
        normalizeForSearch(authorNames.join(' ')),
      ]);
      if (full) await flush();
    }
    await flush();
    this.log(
      `Books: ${step.inserted.toLocaleString('en')} editions inserted, ${step.updated.toLocaleString('en')} updated`,
    );
  }

  private async importGenres(step: StepCounts): Promise<void> {
    const batch = new StagedBatch(
      this.client,
      'stage_edition_genres',
      ['edition_id', 'genre_name', 'votes'],
      this.batchSize,
    );
    const flush = async () => {
      if ((await batch.load()) === 0) return;
      // Unknown genre names and books not in the catalog are dropped by the joins.
      step.inserted += await this.insert(
        `INSERT INTO edition_genres (edition_id, genre_id, votes)
         SELECT s.edition_id, g.id, s.votes FROM stage_edition_genres s
         JOIN genres g ON g.name = s.genre_name
         JOIN editions e ON e.id = s.edition_id
         ON CONFLICT DO NOTHING`,
      );
      await batch.truncate();
    };
    for await (const raw of readJsonLines<RawGenres>(this.file('genres'))) {
      this.progress('Genres', ++step.read);
      if (this.selected && !(raw.book_id && this.selected.has(raw.book_id))) continue;
      for (const row of parseGenres(raw)) {
        if (batch.push([ids.book(row.bookExternalId), row.genre, row.votes])) await flush();
      }
    }
    await flush();
    this.log(`Genres: ${step.inserted.toLocaleString('en')} links inserted`);
  }

  private async importReviews(step: ImportReport['reviews']): Promise<void> {
    const batch = new StagedBatch(
      this.client,
      'stage_reviews',
      [
        'id',
        'edition_id',
        'external_review_id',
        'reviewer_external_id',
        'rating',
        'text',
        'text_length',
        'posted_at',
      ],
      this.batchSize,
    );
    const flush = async () => {
      if ((await batch.load()) === 0) return;
      // Reviews of books that are not in the catalog are dropped by the join.
      step.inserted += await this.insert(
        `INSERT INTO reviews (
           id, edition_id, source_id, external_review_id, reviewer_external_id,
           rating, text, text_length, posted_at, created_at)
         SELECT s.id, s.edition_id, $1, s.external_review_id, s.reviewer_external_id,
           s.rating, s.text, s.text_length, s.posted_at, now()
         FROM stage_reviews s JOIN editions e ON e.id = s.edition_id
         ON CONFLICT DO NOTHING`,
        [this.sourceId],
      );
      await batch.truncate();
    };
    for await (const raw of readJsonLines<RawReview>(this.file('reviews'))) {
      this.progress('Reviews', ++step.read);
      if (this.selected && !(raw.book_id && this.selected.has(raw.book_id))) {
        step.notSelected++;
        continue;
      }
      const review = parseReview(raw);
      if (!review) {
        step.skipped++;
        continue;
      }
      const full = batch.push([
        review.id,
        ids.book(review.bookExternalId),
        review.externalReviewId,
        review.reviewerExternalId,
        review.rating,
        review.text,
        review.textLength,
        review.postedAt,
      ]);
      if (full) await flush();
    }
    await flush();
    this.log(`Reviews: ${step.inserted.toLocaleString('en')} inserted`);
  }

  /** Records how many dataset reviews each edition's rating summary covers. */
  private async updateReviewCounts(): Promise<void> {
    await this.insert(
      `UPDATE review_fetches f SET review_count = c.n
       FROM (SELECT edition_id, count(*)::int AS n FROM reviews WHERE source_id = $1 GROUP BY edition_id) c
       WHERE f.edition_id = c.edition_id AND f.source_id = $1 AND f.reviews_version = 1
         AND f.review_count <> c.n`,
      [this.sourceId],
    );
  }
}
