import { fakeFetch, noPacing, type FakeReply } from '../../../test/helpers/fake-fetch';
import type { BookRef } from '../rating-source';
import { HardcoverRatings } from './hardcover.client';

const book: BookRef = {
  editionId: 'e1',
  title: 'The Hunger Games',
  authors: ['Suzanne Collins'],
  isbn13: '9780439023481',
  isbn10: '0439023483',
  openLibraryWorkKey: null,
};

const edition = (over: Record<string, unknown> = {}) => ({
  title: 'The Hunger Games',
  isbn_13: '9780439023481',
  isbn_10: '0439023483',
  book: {
    id: 88639,
    title: 'The Hunger Games',
    rating: 4.129958703541484,
    ratings_count: 7991,
    compilation: false,
    contributions: [{ author: { name: 'Suzanne Collins' } }],
    ...over,
  },
});

const searchHit = (document: Record<string, unknown>) => ({ document });

/** `null` means no token set. */
function adapter(replies: FakeReply[], token: string | null = 'secret-token') {
  const { fetchImpl, requests } = fakeFetch(replies);
  const hc = new HardcoverRatings({
    token: token ?? undefined,
    userAgent: 'Bookie/test',
    searchResults: 5,
    minTitle: 0.75,
    minAuthor: 0.5,
    timeoutMs: 1000,
    fetchImpl,
    ...noPacing,
  });
  return { hc, requests };
}

const signal = () => new AbortController().signal;

describe('Hardcover ratings adapter (BE-5, D-003, D-020)', () => {
  it('is not asked without a token', () => {
    expect(adapter([], null).hc.configured).toBe(false);
    expect(adapter([]).hc.configured).toBe(true);
  });

  it('looks up by ISBN first with a Bearer token, asking only for aggregate fields', async () => {
    const { hc, requests } = adapter([{ status: 200, body: { data: { editions: [edition()] } } }]);
    const result = await hc.lookup(book, signal());
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.method).toBe('POST');
    expect(request!.headers.authorization).toBe('Bearer secret-token');
    const { query, variables } = request!.body as { query: string; variables: object };
    expect(variables).toEqual({ i13: '9780439023481', i10: '0439023483' });
    // D-003: no reviews, no user data, no images.
    expect(query).not.toMatch(/review_raw|reviews\b|user_books|users|image/);
    expect(result).toEqual({
      outcome: 'ok',
      ratingAverage: 4.13,
      ratingCount: 7991,
      ratingScope: 'work',
      externalId: '88639',
      matchedBy: 'isbn',
    });
  });

  it('accepts a token pasted with "Bearer " already in front', async () => {
    const { hc, requests } = adapter(
      [{ status: 200, body: { data: { editions: [edition()] } } }],
      'Bearer abc',
    );
    await hc.lookup(book, signal());
    expect(requests[0]!.headers.authorization).toBe('Bearer abc');
  });

  it('falls back to search and checks its fuzzy hits in code, preferring non-compilations', async () => {
    const { hc, requests } = adapter([
      { status: 200, body: { data: { editions: [] } } },
      {
        status: 200,
        body: {
          data: {
            search: {
              results: {
                hits: [
                  searchHit({
                    id: '1',
                    title: 'The Hunger Games Trilogy',
                    author_names: ['Suzanne Collins'],
                    compilation: true,
                    rating: 4.5,
                    ratings_count: 900,
                  }),
                  searchHit({
                    id: '2',
                    title: 'THE HUNGER GAMES',
                    author_names: ['Narayan Changder'],
                    rating: 3,
                    ratings_count: 2,
                  }),
                  searchHit({
                    id: '88639',
                    title: 'The Hunger Games',
                    author_names: ['Suzanne Collins'],
                    isbns: ['0439023483'],
                    rating: 4.13,
                    ratings_count: 7991,
                    image: { url: 'x' },
                  }),
                ],
              },
            },
          },
        },
      },
    ]);
    const result = await hc.lookup(book, signal());
    expect((requests[1]!.body as { variables: object }).variables).toEqual({
      q: 'The Hunger Games Suzanne Collins',
      n: 5,
    });
    expect(result).toMatchObject({ outcome: 'ok', externalId: '88639', matchedBy: 'title_author' });
  });

  it('still uses a book flagged as a compilation when it is the only match (Divergent is flagged)', async () => {
    const { hc } = adapter([
      {
        status: 200,
        body: {
          data: {
            editions: [
              edition({
                id: 109344,
                title: 'Divergent',
                compilation: true,
                contributions: [{ author: { name: 'Veronica Roth' } }],
              }),
            ],
          },
        },
      },
    ]);
    const result = await hc.lookup(
      {
        ...book,
        title: 'Divergent',
        authors: ['Veronica Roth'],
        isbn13: '9780062024039',
        isbn10: null,
      },
      signal(),
    );
    expect(result).toMatchObject({ outcome: 'ok', externalId: '109344', matchedBy: 'isbn' });
  });

  it('reports no match (search always returns something) and unrated books as empty', async () => {
    const fuzzy = adapter([
      {
        status: 200,
        body: {
          data: {
            search: {
              results: {
                hits: [
                  searchHit({
                    id: '735432',
                    title: 'The Meadows',
                    author_names: ['Stephanie Oakes'],
                    rating: 2.8,
                    ratings_count: 3,
                  }),
                ],
              },
            },
          },
        },
      },
    ]);
    await expect(
      fuzzy.hc.lookup(
        {
          ...book,
          title: 'Zxqv Plorbing Meadows',
          authors: ['Nobody'],
          isbn13: null,
          isbn10: null,
        },
        signal(),
      ),
    ).resolves.toEqual({ outcome: 'empty', reason: 'not_found' });

    const unrated = adapter([
      { status: 200, body: { data: { editions: [edition({ rating: null, ratings_count: 0 })] } } },
    ]);
    await expect(unrated.hc.lookup(book, signal())).resolves.toEqual({
      outcome: 'empty',
      reason: 'no_ratings',
      externalId: '88639',
    });
  });

  it('reports a refused token, GraphQL errors and rate limits as failures, never as no ratings', async () => {
    const cases: Array<[FakeReply, object]> = [
      [
        { status: 401, body: { error: 'invalid_token' } },
        { outcome: 'failed', code: 'unauthorized' },
      ],
      [
        { status: 403, body: { error: 'unsupported_operation' } },
        { outcome: 'failed', code: 'http_403' },
      ],
      [
        { status: 200, body: { errors: [{ message: 'field not found' }] } },
        { outcome: 'failed', code: 'bad_response' },
      ],
      [
        { status: 200, body: { data: { editions: 'odd' } } },
        { outcome: 'failed', code: 'bad_response' },
      ],
      [{ status: 429, body: {} }, { outcome: 'rate_limited' }],
    ];
    for (const [reply, expected] of cases) {
      const { hc } = adapter([reply]);
      const error = await hc.lookup(book, signal()).catch((e: unknown) => e);
      expect(error).toMatchObject(expected);
      expect(String((error as Error).message)).not.toContain('secret-token');
    }
  });

  it('gives up when the caller stops waiting (deadline), as a timeout failure', async () => {
    const { hc } = adapter(['hang']);
    const controller = new AbortController();
    const pending = hc.lookup(book, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ outcome: 'failed', code: 'timeout' });
  });
});
