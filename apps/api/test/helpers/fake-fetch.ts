/** A scripted `fetch` for source adapters: replies in order, records requests. */
export type FakeReply =
  { status: number; body: unknown; headers?: Record<string, string> } | Error | 'hang';

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeFetch(replies: FakeReply[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit = {}) => {
    requests.push({
      url: new URL(String(url)),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('no more replies');
    if (reply instanceof Error) throw reply;
    if (reply === 'hang') {
      // Never answers; resolves only by the caller aborting.
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** No waiting between requests in unit tests. */
export const noPacing = { minIntervalMs: 0, sleep: async () => undefined };
