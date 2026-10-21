import { fakeFetch, noPacing, type FakeReply } from '../../../test/helpers/fake-fetch';
import type { BookRef } from '../rating-source';
import { GoogleBooksRatings } from './google-books.client';

const book: BookRef = {
  editionId: 'e1',
  title: 'The Hunger Games',
  authors: ['Suzanne Collins'],
  isbn13: '9780439023481',
  isbn10: null,
  openLibraryWorkKey: null,
};

const volume = (
  id: string,
  title: string,
  author: string,
  isbn: string,
  rating?: [number, number],
) => ({
  id,
  volumeInfo: {
    title,
    authors: [author],
    industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }],
    ...(rating ? { averageRating: rating[0], ratingsCount: rating[1] } : {}),
  },
});

function adapter(replies: FakeReply[], over: { enabled?: boolean; apiKey?: string } = {}) {
  const { fetchImpl, requests } = fakeFetch(replies);
  const gb = new GoogleBooksRatings({
    enabled: over.enabled ?? true,
    apiKey: 'apiKey' in over ? over.apiKey : 'secret-key',
    maxResults: 20,
    minTitle: 0.75,
    minAuthor: 0.5,
    timeoutMs: 1000,
    fetchImpl,
    ...noPacing,
  });
  return { gb, requests };
}

const signal = () => new AbortController().signal;
const none = { status: 200, body: {} };

describe('Google Books ratings adapter (BE-5, D-003 live only, D-020)', () => {
  it('is asked only when switched on (off by default) and a key is set', () => {
    expect(adapter([], { enabled: false }).gb.configured).toBe(false);
    expect(adapter([], { apiKey: undefined }).gb.configured).toBe(false);
    expect(adapter([]).gb.configured).toBe(true);
  });

  it('needs an ISBN and asks nothing without one', async () => {
    const { gb, requests } = adapter([]);
    await expect(gb.lookup({ ...book, isbn13: null }, signal())).resolves.toEqual({
      outcome: 'empty',
      reason: 'no_isbn',
    });
    expect(requests).toHaveLength(0);
  });

  it('uses only the volume with this edition ISBN (D-013), found by ISBN or plain title search', async () => {
    const { gb, requests } = adapter([
      none, // isbn: search returns nothing, as seen live.
      {
        status: 200,
        body: {
          items: [
            volume('quiz', 'THE HUNGER GAMES', 'Narayan Changder', '9780000000001', [5, 900]),
            volume(
              'other-edition',
              'The Hunger Games',
              'Suzanne Collins',
              '9781407132082',
              [4.4, 500],
            ),
            volume('ours', 'The Hunger Games', 'Suzanne Collins', '9780439023481', [4.5, 326]),
          ],
        },
        headers: { 'cache-control': 'private, max-age=600' },
      },
    ]);
    const result = await gb.lookup(book, signal());
    expect(requests.map((r) => r.url.searchParams.get('q'))).toEqual([
      'isbn:9780439023481',
      'The Hunger Games',
    ]);
    expect(requests[0]!.url.searchParams.get('key')).toBe('secret-key');
    expect(result).toEqual({
      outcome: 'ok',
      ratingAverage: 4.5,
      ratingCount: 326,
      ratingScope: 'edition',
      externalId: 'ours',
      matchedBy: 'isbn',
      cacheMaxAgeSeconds: 600,
    });
  });

  it('reports another edition only, or a volume without ratings, as empty: no data, never a low score', async () => {
    const otherOnly = adapter([
      none,
      {
        status: 200,
        body: {
          items: [volume('x', 'The Hunger Games', 'Suzanne Collins', '9781407132082', [4.4, 500])],
        },
      },
    ]);
    await expect(otherOnly.gb.lookup(book, signal())).resolves.toEqual({
      outcome: 'empty',
      reason: 'not_found',
    });
    const unrated = adapter([
      {
        status: 200,
        body: { items: [volume('ours', 'The Hunger Games', 'Suzanne Collins', '9780439023481')] },
      },
    ]);
    await expect(unrated.gb.lookup(book, signal())).resolves.toEqual({
      outcome: 'empty',
      reason: 'no_ratings',
      externalId: 'ours',
    });
  });

  it('classifies a refused key, quota and server errors, and never puts the key in a message', async () => {
    const error = (status: number, reason: string, message = '') => ({
      status,
      body: { error: { code: status, message, errors: [{ reason }] } },
    });
    const cases: Array<[FakeReply, object]> = [
      [
        error(400, 'badRequest', 'API key not valid. Please pass a valid API key.'),
        { outcome: 'failed', code: 'unauthorized' },
      ],
      [error(403, 'dailyLimitExceeded'), { outcome: 'rate_limited' }],
      [error(403, 'rateLimitExceeded'), { outcome: 'rate_limited' }],
      [{ status: 429, body: {} }, { outcome: 'rate_limited' }],
      [error(503, 'backendError'), { outcome: 'failed', code: 'http_503' }],
      [
        { status: 200, body: { items: 'odd' } },
        { outcome: 'failed', code: 'bad_response' },
      ],
    ];
    for (const [reply, expected] of cases) {
      const { gb } = adapter([reply]);
      const failure = await gb.lookup(book, signal()).catch((e: unknown) => e);
      expect(failure).toMatchObject(expected);
      expect(String((failure as Error).message)).not.toContain('secret-key');
    }
  });

  it('reports no cache lifetime when Google sends no cache header', async () => {
    const { gb } = adapter([
      {
        status: 200,
        body: {
          items: [volume('ours', 'The Hunger Games', 'Suzanne Collins', '9780439023481', [4.5, 3])],
        },
      },
    ]);
    await expect(gb.lookup(book, signal())).resolves.toMatchObject({ cacheMaxAgeSeconds: null });
  });
});
