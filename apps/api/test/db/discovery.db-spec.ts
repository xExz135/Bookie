import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { normalizeForSearch } from '../../src/catalog/normalize';
import { OPEN_LIBRARY } from '../../src/discovery/book-search.service';
import { COVER_VISION } from '../../src/discovery/scan.service';
import { LlmError } from '../../src/llm/gemini.client';
import type { OpenLibraryWork } from '../../src/sources/open-library/open-library.client';
import { SourceError } from '../../src/sources/open-library/open-library.client';
import { jpeg } from '../helpers/images';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

/** A made-up word, so these books match nothing else in the shared test database. */
const word = () => Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');

const usage = { model: 'fake', inputTokens: 1, outputTokens: 1, latencyMs: 1, waitedMs: 0 };

class FakeVision {
  readonly requests: Array<{ images?: Array<{ mimeType: string; data: Buffer }> }> = [];
  reply: unknown = null;
  error: Error | null = null;

  generateJson = async (
    _model: string,
    request: { images?: Array<{ mimeType: string; data: Buffer }> },
  ) => {
    this.requests.push(request);
    if (this.error) throw this.error;
    return {
      text: typeof this.reply === 'string' ? this.reply : JSON.stringify(this.reply),
      usage,
    };
  };
}

class FakeOpenLibrary {
  readonly queries: string[] = [];
  works: OpenLibraryWork[] = [];
  error: Error | null = null;

  searchWorks = async (query: string) => {
    this.queries.push(query);
    if (this.error) throw this.error;
    return this.works;
  };
}

describe('discovery: search and scan (BE-6)', () => {
  let app: NestExpressApplication;
  let db: Client;
  let token: string;
  let userId: string;
  const vision = new FakeVision();
  const openLibrary = new FakeOpenLibrary();
  const http = () => request(app.getHttpServer());
  const search = (q: string) =>
    http().get('/api/v1/books/search').query({ q }).set('Authorization', `Bearer ${token}`);
  const scan = (image: Buffer, filename = 'cover.jpg', contentType = 'image/jpeg') =>
    http()
      .post('/api/v1/scan')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', image, { filename, contentType });
  const scansUsed = async () =>
    Number(
      (await db.query('SELECT count(*) FROM scan_usages WHERE user_id = $1', [userId])).rows[0]
        .count,
    );

  /** Adds one edition (and its work, unless given) to the catalog. */
  async function seedBook(book: {
    title: string;
    authors: string[];
    workId?: string;
    language?: string | null;
    year?: number | null;
    isbn13?: string | null;
    publisher?: string | null;
    ratings?: number;
  }): Promise<{ editionId: string; workId: string }> {
    const workId = book.workId ?? randomUUID();
    const editionId = randomUUID();
    await db.query(
      `INSERT INTO works (id, title, updated_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [workId, book.title],
    );
    await db.query(
      `INSERT INTO editions (id, work_id, title, language, publication_year, isbn_13, publisher,
         normalized_title, normalized_authors, metadata_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 days', now())`,
      [
        editionId,
        workId,
        book.title,
        book.language ?? 'en',
        book.year ?? 2001,
        book.isbn13 ?? null,
        book.publisher ?? null,
        normalizeForSearch(book.title),
        normalizeForSearch(book.authors.join(' ')),
      ],
    );
    for (const [i, name] of book.authors.entries()) {
      const authorId = randomUUID();
      await db.query(`INSERT INTO authors (id, name, normalized_name) VALUES ($1, $2, $3)`, [
        authorId,
        name,
        normalizeForSearch(name),
      ]);
      await db.query(
        `INSERT INTO edition_authors (edition_id, author_id, position, role) VALUES ($1, $2, $3, $4)`,
        [editionId, authorId, i + 1, i === 0 ? null : 'Illustrator'],
      );
    }
    if (book.ratings !== undefined) {
      await db.query(
        `INSERT INTO review_fetches (id, edition_id, source_id, reviews_version, outcome, rating_count, expires_at)
         VALUES ($1, $2, (SELECT id FROM review_sources WHERE key = 'goodreads_dataset'), 1, 'ok', $3, '9999-12-31')`,
        [randomUUID(), editionId, book.ratings],
      );
    }
    return { editionId, workId };
  }

  beforeAll(async () => {
    ({ app } = await createTestApp({}, [
      { token: COVER_VISION, value: vision },
      { token: OPEN_LIBRARY, value: openLibrary },
    ]));
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('disc'), password: 'discovery password', displayName: 'Dee' })
      .expect(201);
    token = res.body.accessToken;
    userId = res.body.user.id;
  });

  beforeEach(() => {
    vision.requests.length = 0;
    vision.reply = null;
    vision.error = null;
    openLibrary.queries.length = 0;
    openLibrary.works = [];
    openLibrary.error = null;
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  describe('typed search', () => {
    it('DISC-1: an ambiguous query shows one card per book, with every identifying field', async () => {
      const tag = word();
      const keeper = await seedBook({
        title: `The ${tag} Lighthouse Keeper`,
        authors: ['Mara Quist', 'Ilo Penn'],
        year: 2001,
        isbn13: null,
        publisher: 'Harbour Press',
        ratings: 5000,
      });
      // Another edition of the same work: fewer ratings, so not the one shown.
      await seedBook({
        title: `The ${tag} Lighthouse Keeper`,
        authors: ['Mara Quist'],
        workId: keeper.workId,
        language: 'fr',
        ratings: 100,
      });
      await seedBook({
        title: `The ${tag} Lighthouse Keeper's Daughter`,
        authors: ['Ana Roe'],
        ratings: 50,
      });
      await seedBook({
        title: `${tag} Lighthouses of the North`,
        authors: ['B. Sail'],
        ratings: 10,
      });
      await seedBook({ title: `${tag} Lighthouse Recipes`, authors: ['C. Cook'], ratings: 5 });

      const res = await search(`${tag} lighthouse keeper`).expect(200);
      expect(res.body.external).toBeNull();
      expect(res.body.candidates).toHaveLength(3);
      // One edition per work: the most-rated one.
      expect(res.body.candidates[0]).toEqual({
        editionId: keeper.editionId,
        title: `The ${tag} Lighthouse Keeper`,
        subtitle: null,
        // Main author only; the illustrator is not listed as an author.
        author: 'Mara Quist',
        year: 2001,
        language: 'en',
        publisher: 'Harbour Press',
        format: null,
        coverUrl: null,
      });
      const ids = res.body.candidates.map((c: { editionId: string }) => c.editionId);
      expect(new Set(ids).size).toBe(3);
      expect(openLibrary.queries).toEqual([]);
    });

    it('finds a book by ISBN, with or without hyphens', async () => {
      const tag = word();
      const book = await seedBook({
        title: `${tag} Isbn Book`,
        authors: ['I. S. Bean'],
        isbn13: '9780306406157',
      });
      const res = await search('978-0-306-40615-7').expect(200);
      expect(res.body.candidates.map((c: { editionId: string }) => c.editionId)).toContain(
        book.editionId,
      );
    });

    it('rejects an empty or one-letter query', async () => {
      for (const q of ['', ' ', 'a', '!!']) {
        const res = await search(q).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.fields).toHaveProperty('q');
      }
      const missing = await http()
        .get('/api/v1/books/search')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      expect(missing.body.fields).toHaveProperty('q');
    });

    it('falls back to Open Library, adds its result to the catalog, and does not ask twice', async () => {
      const tag = word();
      openLibrary.works = [
        {
          key: `OL${Date.now()}W`,
          title: `${tag} Employees`,
          authors: [{ key: `OL${Date.now()}A`, name: 'Olga Ravn' }],
          firstPublishYear: 2018,
          edition: {
            key: `OL${Date.now()}M`,
            title: `The ${tag} Employees`,
            subtitle: 'A workplace novel',
            language: 'eng',
            isbn10: null,
            isbn13: null,
            publisher: 'Lolli Editions',
            year: 2020,
            format: 'Paperback',
            coverId: 12294759,
          },
        },
      ];
      const first = await search(`the ${tag} employees olga ravn`).expect(200);
      expect(first.body.external).toEqual({ source: 'open_library', outcome: 'ok' });
      expect(first.body.candidates[0]).toMatchObject({
        title: `The ${tag} Employees`,
        subtitle: 'A workplace novel',
        author: 'Olga Ravn',
        year: 2020,
        language: 'en',
        format: 'Paperback',
        coverUrl: 'https://covers.openlibrary.org/b/id/12294759-M.jpg',
      });
      const stored = await db.query(
        `SELECT x.external_id FROM edition_external_ids x
           JOIN review_sources s ON s.id = x.source_id AND s.key = 'open_library'
          WHERE x.edition_id = $1`,
        [first.body.candidates[0].editionId],
      );
      expect(stored.rows).toHaveLength(1);

      const again = await search(`the ${tag} employees olga ravn`).expect(200);
      expect(again.body.candidates[0].editionId).toBe(first.body.candidates[0].editionId);
      expect(openLibrary.queries).toHaveLength(1);
    });

    it('does not duplicate a book the catalog already has (same ISBN)', async () => {
      const tag = word();
      const existing = await seedBook({
        title: `${tag} Known Book`,
        authors: ['Kay Known'],
        isbn13: '9781861972712',
      });
      openLibrary.works = [
        {
          key: `OL${Date.now()}1W`,
          title: `${tag} Known Book`,
          authors: [{ key: null, name: 'Kay Known' }],
          firstPublishYear: 2001,
          edition: {
            key: `OL${Date.now()}1M`,
            title: `${tag} Known Book (Open Library)`,
            subtitle: null,
            language: 'eng',
            isbn10: null,
            isbn13: '9781861972712',
            publisher: null,
            year: 2001,
            format: null,
            coverId: null,
          },
        },
      ];
      // A query the catalog cannot match well, so Open Library is asked.
      await search(`${word()} ${word()}`).expect(200);
      const editions = await db.query(
        `SELECT count(*) FROM editions WHERE normalized_title LIKE $1`,
        [`${tag}%`],
      );
      expect(Number(editions.rows[0].count)).toBe(1);
      const link = await db.query(`SELECT count(*) FROM work_external_ids WHERE work_id = $1`, [
        existing.workId,
      ]);
      expect(Number(link.rows[0].count)).toBe(1);
    });

    it('reports an Open Library failure as failed, not as "no results"', async () => {
      openLibrary.error = new SourceError('failed', 'HTTP 503');
      const res = await search(`${word()} ${word()}`).expect(200);
      expect(res.body).toEqual({
        candidates: [],
        external: { source: 'open_library', outcome: 'failed' },
      });
      openLibrary.error = new SourceError('rate_limited', 'HTTP 429');
      const limited = await search(`${word()} ${word()}`).expect(200);
      expect(limited.body.external.outcome).toBe('rate_limited');
    });
  });

  describe('cover scan', () => {
    const reading = (over: Record<string, unknown> = {}) => ({
      isBook: true,
      readable: true,
      title: '',
      subtitle: '',
      authors: [],
      certainty: 'high',
      ...over,
    });

    it('identifies one clear match, and sends the model the photo without its metadata', async () => {
      const tag = word();
      const book = await seedBook({
        title: `The ${tag} Orchard`,
        authors: ['Ilse Marrow'],
        ratings: 10,
      });
      vision.reply = reading({
        title: `THE ${tag.toUpperCase()} ORCHARD`,
        authors: ['ILSE MARROW'],
      });

      const res = await scan(jpeg({ exif: true })).expect(200);
      expect(res.body.outcome).toBe('identified');
      expect(res.body.candidates[0].editionId).toBe(book.editionId);
      expect(res.body.recognized).toEqual({
        title: `THE ${tag.toUpperCase()} ORCHARD`,
        subtitle: null,
        authors: ['ILSE MARROW'],
      });
      const sent = vision.requests[0]!.images![0]!;
      expect(sent.mimeType).toBe('image/jpeg');
      expect(sent.data.toString('latin1')).not.toContain('GPS');
    });

    it('DISC-2: is uncertain when two books match, so the reader confirms', async () => {
      const tag = word();
      await seedBook({ title: `${tag} Twin Rivers`, authors: ['Nell Twin'] });
      await seedBook({ title: `${tag} Twin Rivers`, authors: ['Nell Twin'], language: 'de' });
      vision.reply = reading({ title: `${tag} Twin Rivers`, authors: ['Nell Twin'] });
      const res = await scan(jpeg()).expect(200);
      expect(res.body.outcome).toBe('uncertain');
      expect(res.body.candidates).toHaveLength(2);
    });

    it('DISC-2: is uncertain when the model was not sure, and when nothing matches', async () => {
      const tag = word();
      await seedBook({ title: `${tag} Quiet Hours`, authors: ['Pia Hour'] });
      vision.reply = reading({
        title: `${tag} Quiet Hours`,
        authors: ['Pia Hour'],
        certainty: 'medium',
      });
      expect((await scan(jpeg()).expect(200)).body.outcome).toBe('uncertain');

      vision.reply = reading({ title: `${word()} ${word()}`, authors: ['Nobody Known'] });
      const none = await scan(jpeg()).expect(200);
      expect(none.body).toMatchObject({ outcome: 'uncertain', candidates: [] });
      // The cover text comes back, so the confirmation screen can offer a typed search.
      expect(none.body.recognized.authors).toEqual(['Nobody Known']);
    });

    it('dismisses a photo that is not a book, or that cannot be read', async () => {
      vision.reply = reading({ isBook: false, readable: false });
      expect((await scan(jpeg()).expect(422)).body.code).toBe('NOT_A_BOOK');
      vision.reply = reading({ readable: false, title: '' });
      expect((await scan(jpeg()).expect(422)).body.code).toBe('UNREADABLE_IMAGE');
    });

    it('DISC-4: rejects a wrong-type upload before processing, whatever it claims to be', async () => {
      const before = await scansUsed();
      const res = await scan(
        Buffer.from('GIF89a not a jpeg at all'),
        'cover.jpg',
        'image/jpeg',
      ).expect(415);
      expect(res.body.code).toBe('UNSUPPORTED_TYPE');
      const broken = await scan(jpeg().subarray(0, 30)).expect(422);
      expect(broken.body.code).toBe('UNREADABLE_IMAGE');
      expect(vision.requests).toHaveLength(0);
      expect(await scansUsed()).toBe(before);
    });

    it('asks for a file when none is attached', async () => {
      const res = await http()
        .post('/api/v1/scan')
        .set('Authorization', `Bearer ${token}`)
        .field('note', 'no image')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('gives the scan back when identification is unavailable', async () => {
      const before = await scansUsed();
      vision.error = new LlmError('unavailable', 'overloaded');
      const res = await scan(jpeg()).expect(503);
      expect(res.body).toMatchObject({ code: 'IDENTIFICATION_UNAVAILABLE', retryable: true });
      vision.error = null;
      vision.reply = 'not json';
      expect((await scan(jpeg()).expect(503)).body.code).toBe('IDENTIFICATION_UNAVAILABLE');
      expect(await scansUsed()).toBe(before);
    });

    it('DISC-3: keeps the photo in memory only: no file on disk, no image in the database', async () => {
      const marker = `bookie-disc3-${randomUUID()}`;
      const photo = Buffer.concat([jpeg(), Buffer.from(marker)]);
      const tmp = tmpdir();
      const before = new Set(readdirSync(tmp));
      vision.reply = reading({ title: `${word()} ${word()}`, authors: ['Any One'] });
      await scan(photo).expect(200);

      for (const name of readdirSync(tmp).filter((n) => !before.has(n))) {
        const path = join(tmp, name);
        try {
          if (statSync(path).isFile() && statSync(path).size < 10_000_000) {
            expect(readFileSync(path).includes(marker)).toBe(false);
          }
        } catch {
          // Removed meanwhile by another process.
        }
      }
      const columns = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'scan_usages' ORDER BY 1`,
      );
      expect(columns.rows.map((r) => r.column_name)).toEqual(['id', 'scanned_at', 'user_id']);
    });
  });
});

describe('scan limits', () => {
  it('DISC-4: rejects an oversized upload before processing', async () => {
    const vision = new FakeVision();
    const { app } = await createTestApp({ SCAN_MAX_UPLOAD_BYTES: '100000' }, [
      { token: COVER_VISION, value: vision },
      { token: OPEN_LIBRARY, value: new FakeOpenLibrary() },
    ]);
    try {
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('big'), password: 'discovery password', displayName: 'Big' })
        .expect(201);
      const big = Buffer.concat([jpeg(), Buffer.alloc(150_000)]);
      const res = await request(app.getHttpServer())
        .post('/api/v1/scan')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .attach('image', big, { filename: 'cover.jpg', contentType: 'image/jpeg' })
        .expect(413);
      expect(res.body.code).toBe('UPLOAD_TOO_LARGE');
      expect(vision.requests).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('enforces the per-reader daily scan quota with Retry-After', async () => {
    const vision = new FakeVision();
    vision.reply = {
      isBook: false,
      readable: false,
      title: '',
      subtitle: '',
      authors: [],
      certainty: 'low',
    };
    const { app } = await createTestApp({ SCAN_DAILY_QUOTA: '2' }, [
      { token: COVER_VISION, value: vision },
      { token: OPEN_LIBRARY, value: new FakeOpenLibrary() },
    ]);
    try {
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('quota'), password: 'discovery password', displayName: 'Q' })
        .expect(201);
      const send = () =>
        request(app.getHttpServer())
          .post('/api/v1/scan')
          .set('Authorization', `Bearer ${reg.body.accessToken}`)
          .attach('image', jpeg(), { filename: 'cover.jpg', contentType: 'image/jpeg' });
      await send().expect(422);
      await send().expect(422);
      const blocked = await send().expect(429);
      expect(blocked.body).toMatchObject({ code: 'SCAN_QUOTA_EXCEEDED', retryable: true });
      expect(blocked.body.retryAfterSeconds).toBeGreaterThan(86_000);
      expect(blocked.headers['retry-after']).toBe(String(blocked.body.retryAfterSeconds));
      expect(vision.requests).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('limits searches per reader per minute', async () => {
    const { app } = await createTestApp({
      SEARCH_RATE_LIMIT_PER_MINUTE: '2',
      OPEN_LIBRARY_ENABLED: 'false',
    });
    try {
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('srl'), password: 'discovery password', displayName: 'S' })
        .expect(201);
      const send = () =>
        request(app.getHttpServer())
          .get('/api/v1/books/search')
          .query({ q: 'anything at all' })
          .set('Authorization', `Bearer ${reg.body.accessToken}`);
      await send().expect(200);
      await send().expect(200);
      const blocked = await send().expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});
