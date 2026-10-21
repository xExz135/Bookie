import { fakeFetch, noPacing, type FakeReply } from '../../../test/helpers/fake-fetch';
import type { BookRef } from '../rating-source';
import { SourceError } from '../source-error';
import { OpenLibraryRatings } from './open-library-ratings';
import { OpenLibraryClient } from './open-library.client';

const book: BookRef = {
  editionId: 'e1',
  title: 'The Hunger Games',
  authors: ['Suzanne Collins'],
  isbn13: '9780439023481',
  isbn10: null,
  openLibraryWorkKey: null,
};

const work = (key: string, title: string, author: string) => ({
  key: `/works/${key}`,
  title,
  author_name: [author],
  editions: { docs: [{ key: '/books/OL1M', title }] },
});

const ratings = (average: number | null, count: number) => ({
  summary: { average, count },
  counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: count },
});

function adapter(replies: FakeReply[]) {
  const { fetchImpl, requests } = fakeFetch(replies);
  const client = new OpenLibraryClient({
    userAgent: 'Bookie/test',
    timeoutMs: 1000,
    fetchImpl,
    ...noPacing,
  });
  const ol = new OpenLibraryRatings(client, { minTitle: 0.75, minAuthor: 0.5, searchResults: 5 });
  return { ol, requests };
}

const signal = () => new AbortController().signal;

describe('Open Library ratings adapter (BE-5, D-003, D-020)', () => {
  it('uses the work key the catalog already has, and reports the rating for the whole work', async () => {
    const { ol, requests } = adapter([{ status: 200, body: ratings(4.135, 570) }]);
    const result = await ol.lookup({ ...book, openLibraryWorkKey: 'OL5735363W' }, signal());
    expect(requests.map((r) => r.url.pathname)).toEqual(['/works/OL5735363W/ratings.json']);
    expect(requests[0]!.headers['user-agent']).toBe('Bookie/test');
    expect(result).toEqual({
      outcome: 'ok',
      ratingAverage: 4.14,
      ratingCount: 570,
      ratingScope: 'work',
      externalId: 'OL5735363W',
      matchedBy: 'known_id',
    });
  });

  it('finds the work by ISBN, checking title and author', async () => {
    const { ol, requests } = adapter([
      { status: 200, body: { docs: [work('OL5735363W', 'The Hunger Games', 'Suzanne Collins')] } },
      { status: 200, body: ratings(4.1, 10) },
    ]);
    const result = await ol.lookup(book, signal());
    expect(requests[0]!.url.searchParams.get('q')).toBe('isbn:9780439023481');
    expect(result).toMatchObject({ outcome: 'ok', matchedBy: 'isbn', externalId: 'OL5735363W' });
  });

  it('ignores an ISBN hit that is another book and falls back to title and author', async () => {
    const { ol, requests } = adapter([
      { status: 200, body: { docs: [work('OL9W', 'Retrospectiva', 'Museo Castagnino')] } },
      { status: 200, body: { docs: [work('OL5735363W', 'The Hunger Games', 'Suzanne Collins')] } },
      { status: 200, body: ratings(4.1, 10) },
    ]);
    const result = await ol.lookup(book, signal());
    expect(requests[1]!.url.searchParams.get('q')).toBe('The Hunger Games Suzanne Collins');
    expect(result).toMatchObject({
      outcome: 'ok',
      matchedBy: 'title_author',
      externalId: 'OL5735363W',
    });
  });

  it('reports a book it cannot find, or one nobody rated, as empty with the reason', async () => {
    const notFound = adapter([
      { status: 200, body: { docs: [] } },
      {
        status: 200,
        body: { docs: [work('OL2W', 'The Hunger Games Trilogy', 'Suzanne Collins')] },
      },
    ]);
    await expect(notFound.ol.lookup(book, signal())).resolves.toEqual({
      outcome: 'empty',
      reason: 'not_found',
    });
    const unrated = adapter([{ status: 200, body: ratings(null, 0) }]);
    await expect(
      unrated.ol.lookup({ ...book, openLibraryWorkKey: 'OL1W' }, signal()),
    ).resolves.toEqual({ outcome: 'empty', reason: 'no_ratings', externalId: 'OL1W' });
  });

  it('never turns a failure into empty (spec 8, RES-4)', async () => {
    for (const [reply, outcome] of [
      [{ status: 503, body: {} }, 'failed'],
      [{ status: 429, body: {} }, 'rate_limited'],
      [new TypeError('fetch failed'), 'failed'],
      [{ status: 200, body: { summary: 'odd' } }, 'failed'],
    ] as Array<[FakeReply, string]>) {
      const { ol } = adapter([reply]);
      const lookup = ol.lookup({ ...book, openLibraryWorkKey: 'OL1W' }, signal());
      await expect(lookup).rejects.toBeInstanceOf(SourceError);
      await expect(
        adapter([reply]).ol.lookup({ ...book, openLibraryWorkKey: 'OL1W' }, signal()),
      ).rejects.toMatchObject({ outcome });
    }
  });
});
