import { OpenLibraryClient, SourceError } from './open-library.client';

function client(
  replies: Array<{ status: number; body: unknown } | Error>,
  overrides: { minIntervalMs?: number } = {},
) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const waits: number[] = [];
  let clock = 0;
  const ol = new OpenLibraryClient({
    userAgent: 'Bookie/test (+https://example.test)',
    timeoutMs: 1000,
    minIntervalMs: overrides.minIntervalMs ?? 1000,
    fetchImpl: (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      const reply = replies.shift();
      if (!reply) throw new Error('no more replies');
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  return { ol, calls, waits };
}

const doc = {
  key: '/works/OL25803688W',
  title: 'De ansatte',
  author_name: ['Olga Ravn'],
  author_key: ['OL9760936A'],
  first_publish_year: 2018,
  editions: {
    docs: [
      {
        key: '/books/OL35547833M',
        title: 'The Employees',
        subtitle: 'A workplace novel of the 22nd century',
        cover_i: 12294759,
        language: ['eng'],
        publisher: ['Lolli Editions'],
        publish_date: ['Sep 21, 2020'],
        isbn: ['9781999992880', '1999992881'],
      },
    ],
  },
};

describe('Open Library client (D-003)', () => {
  it('identifies itself, asks for the needed fields, and parses works with their best edition', async () => {
    const { ol, calls } = client([{ status: 200, body: { docs: [doc] } }]);
    const works = await ol.searchWorks('the employees olga ravn', { limit: 5, language: 'en' });
    expect(calls[0]!.headers['User-Agent']).toBe('Bookie/test (+https://example.test)');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/search.json');
    expect(url.searchParams.get('q')).toBe('the employees olga ravn');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('fields')).toContain('editions.isbn');
    expect(works).toEqual([
      {
        key: 'OL25803688W',
        title: 'De ansatte',
        authors: [{ key: 'OL9760936A', name: 'Olga Ravn' }],
        firstPublishYear: 2018,
        edition: {
          key: 'OL35547833M',
          title: 'The Employees',
          subtitle: 'A workplace novel of the 22nd century',
          language: 'eng',
          isbn13: '9781999992880',
          isbn10: '1999992881',
          publisher: 'Lolli Editions',
          year: 2020,
          format: null,
          coverId: 12294759,
        },
      },
    ]);
  });

  it('treats every field as untrusted: wrong types are dropped, long text is capped', async () => {
    const { ol } = client([
      {
        status: 200,
        body: {
          docs: [
            { key: 'not-a-key', title: 'Dropped: bad key' },
            { key: '/works/OL1W', title: 42 },
            {
              key: '/works/OL2W',
              title: 'x'.repeat(5000),
              author_name: [null, 'Real Name'],
              editions: {
                docs: [{ key: '/books/OL3M', title: 'Ok', cover_i: -5, isbn: [1, 'abc'] }],
              },
            },
          ],
        },
      },
    ]);
    const [work, ...rest] = await ol.searchWorks('q', { limit: 5 });
    expect(rest).toEqual([]);
    expect(work!.title).toHaveLength(500);
    expect(work!.authors).toEqual([{ key: null, name: 'Real Name' }]);
    expect(work!.edition).toMatchObject({ coverId: null, isbn10: null, isbn13: null });
  });

  it('reports 429 as rate_limited and other failures as failed, never as empty', async () => {
    const cases: Array<[{ status: number; body: unknown } | Error, string]> = [
      [{ status: 429, body: {} }, 'rate_limited'],
      [{ status: 503, body: {} }, 'failed'],
      [new TypeError('fetch failed'), 'failed'],
      [{ status: 200, body: { unexpected: true } }, 'failed'],
    ];
    for (const [reply, outcome] of cases) {
      const { ol } = client([reply]);
      await expect(ol.searchWorks('q', { limit: 5 })).rejects.toEqual(
        expect.objectContaining({ outcome }),
      );
      await expect(client([reply]).ol.searchWorks('q', { limit: 5 })).rejects.toBeInstanceOf(
        SourceError,
      );
    }
  });

  it('keeps at least the minimum interval between requests', async () => {
    const { ol, waits } = client([
      { status: 200, body: { docs: [] } },
      { status: 200, body: { docs: [] } },
    ]);
    await ol.searchWorks('a', { limit: 1 });
    await ol.searchWorks('b', { limit: 1 });
    expect(waits).toEqual([1000]);
  });
});
