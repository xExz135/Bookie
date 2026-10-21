import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { normalizeForSearch } from '../../src/catalog/normalize';
import { OPEN_LIBRARY } from '../../src/discovery/book-search.service';
import { TasteProfileService } from '../../src/taste/taste-profile.service';
import { randomIsbn13 } from '../helpers/isbn';
import { createTestApp, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

const word = () => Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');

const GOODREADS_HEADER =
  'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies';

function goodreadsCsv(
  rows: Array<{
    id: string;
    title: string;
    author: string;
    isbn13?: string;
    rating: number;
    review?: string;
  }>,
): Buffer {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.id,
      q(r.title),
      r.author,
      q(r.author),
      '',
      q('=""'),
      q(`=${q(r.isbn13 ?? '')}`),
      r.rating,
      '4.0',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      r.rating === 0 ? 'to-read' : 'read',
      q(r.review ?? ''),
      '',
      '',
      '1',
      '0',
    ].join(','),
  );
  return Buffer.from([GOODREADS_HEADER, ...lines].join('\n'));
}

describe('taste capture (BE-7)', () => {
  let app: NestExpressApplication;
  let db: Client;
  const http = () => request(app.getHttpServer());

  async function signUp(): Promise<{ token: string; id: string }> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('taste'), password: 'taste password!', displayName: 'Tess' })
      .expect(201);
    return { token: res.body.accessToken, id: res.body.user.id };
  }

  async function seedBook(book: {
    title: string;
    author: string;
    workId?: string;
    goodreadsId?: string;
    isbn13?: string;
  }): Promise<{ editionId: string; workId: string }> {
    const workId = book.workId ?? randomUUID();
    const editionId = randomUUID();
    await db.query(
      `INSERT INTO works (id, title, updated_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [workId, book.title],
    );
    await db.query(
      `INSERT INTO editions (id, work_id, title, isbn_13, normalized_title, normalized_authors,
         metadata_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days', now())`,
      [
        editionId,
        workId,
        book.title,
        book.isbn13 ?? null,
        normalizeForSearch(book.title),
        normalizeForSearch(book.author),
      ],
    );
    const authorId = randomUUID();
    await db.query(`INSERT INTO authors (id, name, normalized_name) VALUES ($1, $2, $3)`, [
      authorId,
      book.author,
      normalizeForSearch(book.author),
    ]);
    await db.query(
      `INSERT INTO edition_authors (edition_id, author_id, position) VALUES ($1, $2, 1)`,
      [editionId, authorId],
    );
    if (book.goodreadsId) {
      await db.query(
        `INSERT INTO edition_external_ids (edition_id, source_id, external_id)
         VALUES ($1, (SELECT id FROM review_sources WHERE key = 'goodreads_dataset'), $2)`,
        [editionId, book.goodreadsId],
      );
    }
    return { editionId, workId };
  }

  async function waitForImport(token: string, importId: string) {
    for (let i = 0; i < 100; i++) {
      const res = await http()
        .get(`/api/v1/ratings/import/${importId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      if (res.body.status !== 'processing') return res.body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('import did not finish');
  }

  beforeAll(async () => {
    ({ app } = await createTestApp({}, [
      { token: OPEN_LIBRARY, value: { searchWorks: async () => [] } },
    ]));
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  describe('ONB-1: import', () => {
    it('matches by Goodreads id, ISBN and unique title, lists the rest, and creates a version on confirm', async () => {
      const tag = word();
      const isbn13 = randomIsbn13();
      const goodreadsId = String(randomInt(100_000_000, 999_999_999));
      const byId = await seedBook({ title: `${tag} Exact Id`, author: 'Ada Id', goodreadsId });
      const byIsbn = await seedBook({
        title: `${tag} By Isbn`,
        author: 'Ben Isbn',
        isbn13: isbn13,
      });
      const byTitle = await seedBook({ title: `The ${tag} Garden Path`, author: 'Cleo Path' });
      const twinA = await seedBook({ title: `${tag} Twin Harbour`, author: 'Dee Twin' });
      const twinB = await seedBook({ title: `${tag} Twin Harbour`, author: 'Dee Twin' });

      const { token, id: userId } = await signUp();
      const file = goodreadsCsv([
        {
          id: goodreadsId,
          title: 'Some other title the id wins over',
          author: 'Ada Id',
          rating: 5,
        },
        {
          id: '1',
          title: `${tag} By Isbn`,
          author: 'Ben Isbn',
          isbn13: isbn13,
          rating: 4,
        },
        {
          id: '2',
          title: `The ${tag} Garden Path (Path Series, #1)`,
          author: 'Cleo Path',
          rating: 3,
          review: 'My private review, with a comma',
        },
        { id: '3', title: `${tag} Twin Harbour`, author: 'Dee Twin', rating: 2 },
        { id: '4', title: `${word()} ${word()}`, author: 'Nobody Known', rating: 1 },
        { id: '5', title: 'Want to read', author: 'Some One', rating: 0 },
      ]);

      const started = await http()
        .post('/api/v1/ratings/import')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', file, { filename: 'goodreads_library_export.csv', contentType: 'text/csv' })
        .expect(202);
      const view = await waitForImport(token, started.body.importId);

      expect(view).toMatchObject({
        status: 'needs_review',
        format: 'goodreads',
        totalRows: 5,
        matchedCount: 3,
        ignoredRows: 1,
      });
      expect(view.unmatched.map((r: { rowIndex: number }) => r.rowIndex)).toEqual([4, 5]);
      const twinRow = view.unmatched[0];
      expect(twinRow).toMatchObject({
        rawTitle: `${tag} Twin Harbour`,
        rawAuthor: 'Dee Twin',
        rating: 2,
      });
      expect(twinRow.candidates.map((c: { editionId: string }) => c.editionId).sort()).toEqual(
        [twinA.editionId, twinB.editionId].sort(),
      );
      expect(view.unmatched[1].candidates).toEqual([]);

      // Only title, author and rating are kept: never the review text.
      const stored = await db.query(
        `SELECT row_to_json(r)::text AS row FROM rating_import_rows r WHERE import_id = $1`,
        [started.body.importId],
      );
      expect(stored.rows.map((r) => r.row).join()).not.toContain('private review');

      const confirmed = await http()
        .post(`/api/v1/ratings/import/${started.body.importId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ resolutions: [{ rowIndex: 4, editionId: twinB.editionId }] })
        .expect(200);
      expect(confirmed.body).toEqual({ tasteProfileVersion: 1, ratedCount: 4 });

      const ratings = await db.query(
        `SELECT r.edition_id, r.rating, r.origin FROM profile_ratings r
           JOIN taste_profile_versions v ON v.id = r.taste_profile_version_id
          WHERE v.user_id = $1 ORDER BY r.rating DESC`,
        [userId],
      );
      expect(ratings.rows).toEqual([
        { edition_id: byId.editionId, rating: 5, origin: 'imported' },
        { edition_id: byIsbn.editionId, rating: 4, origin: 'imported' },
        { edition_id: byTitle.editionId, rating: 3, origin: 'imported' },
        { edition_id: twinB.editionId, rating: 2, origin: 'imported' },
      ]);
      // The unresolved row was listed, then skipped on confirm.
      const skipped = await db.query(
        `SELECT status FROM rating_import_rows WHERE import_id = $1 AND row_index = 5`,
        [started.body.importId],
      );
      expect(skipped.rows[0].status).toBe('skipped');

      const again = await http()
        .post(`/api/v1/ratings/import/${started.body.importId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ resolutions: [] })
        .expect(409);
      expect(again.body.code).toBe('CONFLICT');
    });

    it('another reader cannot see or confirm an import (404, SEC-1)', async () => {
      const owner = await signUp();
      const other = await signUp();
      const started = await http()
        .post('/api/v1/ratings/import')
        .set('Authorization', `Bearer ${owner.token}`)
        .attach(
          'file',
          goodreadsCsv([{ id: '9', title: `${word()} Book`, author: 'X Y', rating: 3 }]),
          {
            filename: 'export.csv',
            contentType: 'text/csv',
          },
        )
        .expect(202);
      await waitForImport(owner.token, started.body.importId);
      await http()
        .get(`/api/v1/ratings/import/${started.body.importId}`)
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
      await http()
        .post(`/api/v1/ratings/import/${started.body.importId}/confirm`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ resolutions: [] })
        .expect(404);
    });

    it('rejects unknown files, files with no ratings, and bad resolutions', async () => {
      const { token } = await signUp();
      const upload = (data: Buffer) =>
        http()
          .post('/api/v1/ratings/import')
          .set('Authorization', `Bearer ${token}`)
          .attach('file', data, { filename: 'export.csv', contentType: 'text/csv' });
      expect((await upload(Buffer.from('name,score\nx,1')).expect(400)).body.fields).toHaveProperty(
        'file',
      );
      expect(
        (await upload(goodreadsCsv([{ id: '1', title: 'T', author: 'A', rating: 0 }])).expect(400))
          .body.fields.file,
      ).toContain('No rated books');
      expect((await upload(Buffer.from([0xff, 0xfe, 0, 0x41])).expect(415)).body.code).toBe(
        'UNSUPPORTED_TYPE',
      );

      const started = await upload(
        goodreadsCsv([{ id: '7', title: `${word()} Lone`, author: 'L M', rating: 4 }]),
      ).expect(202);
      await waitForImport(token, started.body.importId);
      const bad = await http()
        .post(`/api/v1/ratings/import/${started.body.importId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          resolutions: [
            { rowIndex: 99, skip: true },
            { rowIndex: 1, editionId: randomUUID() },
          ],
        })
        .expect(400);
      expect(Object.keys(bad.body.fields).sort()).toEqual([
        'resolutions.0.rowIndex',
        'resolutions.1.editionId',
      ]);
    });
  });

  describe('ONB-2: skipping onboarding', () => {
    it('records the skip, and completing taste input later wins', async () => {
      const { token } = await signUp();
      await http()
        .post('/api/v1/onboarding/skip')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const me = await http().get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(me.body.onboardingState).toBe('skipped');

      const profile = await http()
        .get('/api/v1/taste-profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(profile.body).toMatchObject({
        version: 0,
        ratedCount: 0,
        minForConfidence: 10,
        hardFloor: 3,
      });

      const book = await seedBook({ title: `${word()} Later Read`, author: 'Lia Later' });
      await http()
        .put(`/api/v1/ratings/${book.editionId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 4 })
        .expect(200);
      await http()
        .post('/api/v1/onboarding/skip')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const after = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.onboardingState).toBe('completed');
    });
  });

  describe('ONB-3: unknown answers stay unknown', () => {
    it('stores unanswered fields as nothing and returns them as null, never as dislikes', async () => {
      const { token, id } = await signUp();
      const saved = await http()
        .put('/api/v1/questionnaire')
        .set('Authorization', `Bearer ${token}`)
        .send({ likedGenres: ['fiction'], dislikedGenres: null, pace: null })
        .expect(200);
      expect(saved.body.tasteProfileVersion).toBe(1);

      const profile = await http()
        .get('/api/v1/taste-profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(profile.body.questionnaire).toEqual({
        likedGenres: ['fiction'],
        dislikedGenres: null,
        pace: null,
        themesToAvoid: null,
      });
      const rows = await db.query(
        `SELECT p.preference FROM profile_genre_preferences p
           JOIN taste_profile_versions v ON v.id = p.taste_profile_version_id WHERE v.user_id = $1`,
        [id],
      );
      expect(rows.rows).toEqual([{ preference: 'liked' }]);
      const version = await db.query(`SELECT pace FROM taste_profile_versions WHERE user_id = $1`, [
        id,
      ]);
      expect(version.rows[0].pace).toBeNull();
    });

    it('accepts the server lists only, and rejects contradictions', async () => {
      const { token } = await signUp();
      const options = await http()
        .get('/api/v1/questionnaire/options')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(options.body.paces).toEqual(['slow', 'moderate', 'fast']);
      expect(options.body.genres).toContain('fiction');
      expect(options.body.themes.length).toBeGreaterThan(0);

      const unknownGenre = await http()
        .put('/api/v1/questionnaire')
        .set('Authorization', `Bearer ${token}`)
        .send({ likedGenres: ['space opera'] })
        .expect(400);
      expect(unknownGenre.body.fields).toHaveProperty('likedGenres');
      const both = await http()
        .put('/api/v1/questionnaire')
        .set('Authorization', `Bearer ${token}`)
        .send({ likedGenres: ['fiction'], dislikedGenres: ['fiction'] })
        .expect(400);
      expect(both.body.fields).toHaveProperty('dislikedGenres');
      const theme = options.body.themes[0];
      const saved = await http()
        .put('/api/v1/questionnaire')
        .set('Authorization', `Bearer ${token}`)
        .send({ pace: 'fast', themesToAvoid: [{ theme, sensitivity: 'high' }] })
        .expect(200);
      expect(saved.body.tasteProfileVersion).toBe(1);
    });
  });

  describe('ONB-4: versions', () => {
    it('editing a rating creates a new version, leaves the old one unchanged, and marks it outdated', async () => {
      const { token, id } = await signUp();
      const book = await seedBook({ title: `${word()} Versioned`, author: 'Vera Sion' });
      const rate = (rating: number) =>
        http()
          .put(`/api/v1/ratings/${book.editionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ rating });

      expect((await rate(4).expect(200)).body).toEqual({ tasteProfileVersion: 1, ratedCount: 1 });
      // The same rating again changes nothing, so no new version.
      expect((await rate(4).expect(200)).body).toEqual({ tasteProfileVersion: 1, ratedCount: 1 });
      expect((await rate(2).expect(200)).body).toEqual({ tasteProfileVersion: 2, ratedCount: 1 });

      const versions = await db.query(
        `SELECT v.id, v.version_no, r.rating FROM taste_profile_versions v
           JOIN profile_ratings r ON r.taste_profile_version_id = v.id
          WHERE v.user_id = $1 ORDER BY v.version_no`,
        [id],
      );
      expect(versions.rows.map((r) => [r.version_no, r.rating])).toEqual([
        [1, 4],
        [2, 2],
      ]);
      // Old versions cannot be changed, even directly in the database.
      await expect(
        db.query(`UPDATE profile_ratings SET rating = 5 WHERE taste_profile_version_id = $1`, [
          versions.rows[0].id,
        ]),
      ).rejects.toThrow(/immutable/);

      const profiles = app.get(TasteProfileService);
      expect(await profiles.isOutdated(id, versions.rows[0].id)).toBe(true);
      expect(await profiles.isOutdated(id, versions.rows[1].id)).toBe(false);

      // The questionnaire is a new version too, and keeps the ratings.
      const q = await http()
        .put('/api/v1/questionnaire')
        .set('Authorization', `Bearer ${token}`)
        .send({ pace: 'slow' })
        .expect(200);
      expect(q.body).toEqual({ tasteProfileVersion: 3, ratedCount: 1 });

      const removed = await http()
        .delete(`/api/v1/ratings/${book.editionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(removed.body).toEqual({ tasteProfileVersion: 4, ratedCount: 0 });
    });

    it('keeps version numbers in order when saves overlap', async () => {
      const { token, id } = await signUp();
      const books = await Promise.all(
        Array.from({ length: 5 }, () =>
          seedBook({ title: `${word()} Parallel`, author: 'Par Allel' }),
        ),
      );
      await Promise.all(
        books.map((b) =>
          http()
            .put(`/api/v1/ratings/${b.editionId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ rating: 3 })
            .expect(200),
        ),
      );
      const versions = await db.query(
        `SELECT v.version_no, count(r.*)::int AS n FROM taste_profile_versions v
           LEFT JOIN profile_ratings r ON r.taste_profile_version_id = v.id
          WHERE v.user_id = $1 GROUP BY v.version_no ORDER BY v.version_no`,
        [id],
      );
      expect(versions.rows).toEqual([1, 2, 3, 4, 5].map((n) => ({ version_no: n, n })));
    });
  });

  describe('quick rate', () => {
    it('validates the rating and the book', async () => {
      const { token } = await signUp();
      const book = await seedBook({ title: `${word()} Valid`, author: 'Val Id' });
      for (const rating of [0, 6, 2.5, 'five']) {
        await http()
          .put(`/api/v1/ratings/${book.editionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ rating })
          .expect(400);
      }
      await http()
        .put(`/api/v1/ratings/${randomUUID()}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 3 })
        .expect(404);
      await http()
        .put('/api/v1/ratings/not-an-id')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 3 })
        .expect(404);
    });

    it("lists the reader's ratings in pages, and shows them in catalog search", async () => {
      const { token } = await signUp();
      const tag = word();
      const books = [];
      for (const name of ['Alpha', 'Bravo', 'Charlie']) {
        books.push(await seedBook({ title: `${tag} ${name}`, author: 'Page Author' }));
      }
      for (const [i, b] of books.entries()) {
        await http()
          .put(`/api/v1/ratings/${b.editionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ rating: i + 1 })
          .expect(200);
      }
      const first = await http()
        .get('/api/v1/ratings')
        .query({ limit: 2 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        first.body.items.map((i: { title: string; rating: number }) => [i.title, i.rating]),
      ).toEqual([
        [`${tag} Alpha`, 1],
        [`${tag} Bravo`, 2],
      ]);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await http()
        .get('/api/v1/ratings')
        .query({ limit: 2, cursor: first.body.nextCursor })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(second.body).toMatchObject({
        nextCursor: null,
        items: [{ title: `${tag} Charlie`, rating: 3, origin: 'quick_rate' }],
      });
      await http()
        .get('/api/v1/ratings')
        .query({ cursor: 'garbage' })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      const found = await http()
        .get('/api/v1/catalog/search')
        .query({ q: `${tag} charlie` })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(found.body.items[0]).toMatchObject({ title: `${tag} Charlie`, yourRating: 3 });

      const popular = await http()
        .get('/api/v1/catalog/search')
        .query({ limit: 5 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(popular.body.items.length).toBeLessThanOrEqual(5);
      expect(popular.body.external).toBeNull();
    });
  });
});

describe('taste capture limits', () => {
  it('rejects an oversized import before reading it', async () => {
    const { app } = await createTestApp({ IMPORT_MAX_BYTES: '100000' });
    try {
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('bigimp'), password: 'taste password!', displayName: 'B' })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/api/v1/ratings/import')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .attach('file', Buffer.alloc(150_000, 'a'), {
          filename: 'export.csv',
          contentType: 'text/csv',
        })
        .expect(413);
      expect(res.body.code).toBe('UPLOAD_TOO_LARGE');
    } finally {
      await app.close();
    }
  });

  it('refuses to skip onboarding when skipping is turned off (D-002)', async () => {
    const { app } = await createTestApp({ ONBOARDING_ALLOW_SKIP: 'false' });
    try {
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('noskip'), password: 'taste password!', displayName: 'N' })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/api/v1/onboarding/skip')
        .set('Authorization', `Bearer ${reg.body.accessToken}`)
        .expect(409);
      expect(res.body.code).toBe('CONFLICT');
    } finally {
      await app.close();
    }
  });
});
