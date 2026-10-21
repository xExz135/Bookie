import { GeminiClient, LlmError } from './gemini.client';

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('no more fake replies');
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(
  replies: Reply[],
  overrides: Partial<ConstructorParameters<typeof GeminiClient>[0]> = {},
) {
  const fake = fakeFetch(replies);
  const waits: number[] = [];
  const gemini = new GeminiClient({
    apiKey: 'test-key',
    timeoutMs: 1000,
    maxRequestsPerMinute: 60_000,
    tokensPerMinute: 1_000_000,
    transientRetries: 2,
    fetchImpl: fake.impl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });
  return { gemini, calls: fake.calls, waits };
}

const jsonReply = (text: string): Reply => ({
  status: 200,
  body: {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
  },
});

describe('GeminiClient', () => {
  it('sends the key in a header, never in the URL', async () => {
    const { gemini, calls } = client([jsonReply('{}')]);
    await gemini.generateJson('m', { system: 's', user: 'u', schema: {} });
    expect(calls[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(calls[0]!.url).not.toContain('test-key');
  });

  it('asks for JSON with the schema and reports token usage', async () => {
    const { gemini, calls } = client([jsonReply('{"a":1}')]);
    const result = await gemini.generateJson('small-model', {
      system: 'rules',
      user: 'data',
      schema: { type: 'object' },
    });
    expect(result.text).toBe('{"a":1}');
    expect(result.usage).toMatchObject({
      model: 'small-model',
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(calls[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'rules' }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        temperature: 0,
      },
    });
  });

  it('sends images inline before the text', async () => {
    const { gemini, calls } = client([jsonReply('{}')]);
    await gemini.generateJson('vision', {
      system: 's',
      user: 'what book is this?',
      schema: {},
      images: [{ mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) }],
    });
    expect(calls[0]!.body).toMatchObject({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: '/9j/' } },
            { text: 'what book is this?' },
          ],
        },
      ],
    });
  });

  it('embeds texts in one batch request and checks the vector size', async () => {
    const { gemini, calls } = client([
      { status: 200, body: { embeddings: [{ values: [1, 0] }, { values: [0, 1] }] } },
    ]);
    const { vectors } = await gemini.embed('emb', ['a', 'b'], {
      taskType: 'SEMANTIC_SIMILARITY',
      dimensions: 2,
    });
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]!.url).toMatch(/models\/emb:batchEmbedContents$/);
  });

  it('rejects vectors of the wrong size', async () => {
    const { gemini } = client([{ status: 200, body: { embeddings: [{ values: [1, 0, 0] }] } }]);
    await expect(
      gemini.embed('emb', ['a'], { taskType: 'SEMANTIC_SIMILARITY', dimensions: 2 }),
    ).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('retries an overloaded model, then succeeds', async () => {
    const { gemini, calls, waits } = client([
      { status: 503, body: { error: { message: 'high demand' } } },
      jsonReply('{}'),
    ]);
    await gemini.generateJson('m', { system: 's', user: 'u', schema: {} });
    expect(calls).toHaveLength(2);
    expect(waits).toContain(2000);
  });

  it('honours the retry delay Google sends with a rate limit', async () => {
    const { gemini, waits } = client([
      { status: 429, body: { error: { message: 'slow down', details: [{ retryDelay: '7s' }] } } },
      jsonReply('{}'),
    ]);
    await gemini.generateJson('m', { system: 's', user: 'u', schema: {} });
    expect(waits).toContain(7000);
  });

  it('reports the quota as exhausted when the wait would be too long', async () => {
    const { gemini, calls } = client([
      {
        status: 429,
        body: { error: { message: 'daily quota' } },
        headers: { 'retry-after': '3600' },
      },
    ]);
    await expect(
      gemini.generateJson('m', { system: 's', user: 'u', schema: {} }),
    ).rejects.toMatchObject({
      kind: 'quota',
      retryAfterSeconds: 3600,
    });
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured number of retries', async () => {
    const unavailable: Reply = { status: 500, body: { error: { message: 'boom' } } };
    const { gemini, calls } = client([unavailable, unavailable, unavailable]);
    await expect(
      gemini.generateJson('m', { system: 's', user: 'u', schema: {} }),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a rejected request', async () => {
    const { gemini, calls } = client([{ status: 400, body: { error: { message: 'bad schema' } } }]);
    await expect(
      gemini.generateJson('m', { system: 's', user: 'u', schema: {} }),
    ).rejects.toMatchObject({
      kind: 'invalid_request',
      message: 'bad schema',
    });
    expect(calls).toHaveLength(1);
  });

  it('treats a blocked or empty answer as blocked', async () => {
    const { gemini } = client([
      { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } },
    ]);
    await expect(
      gemini.generateJson('m', { system: 's', user: 'u', schema: {} }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('fails clearly without an API key', async () => {
    const { gemini, calls } = client([], { apiKey: undefined });
    await expect(
      gemini.generateJson('m', { system: 's', user: 'u', schema: {} }),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(calls).toHaveLength(0);
  });

  it('waits a full minute after a rate limit that states no delay', async () => {
    const { gemini, waits } = client([
      { status: 429, body: { error: { message: 'quota' } } },
      jsonReply('{}'),
    ]);
    await gemini.generateJson('m', { system: 's', user: 'u', schema: {} });
    expect(waits).toContain(60_000);
  });

  it('paces by estimated tokens per minute', async () => {
    let clock = 1_000_000;
    const waits: number[] = [];
    const fake = fakeFetch([jsonReply('{}'), jsonReply('{}')]);
    const gemini = new GeminiClient({
      apiKey: 'test-key',
      timeoutMs: 1000,
      maxRequestsPerMinute: 60_000,
      tokensPerMinute: 200,
      transientRetries: 0,
      fetchImpl: fake.impl,
      now: () => clock,
      // A fake sleep that moves the fake clock, like real waiting would.
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const big = 'x'.repeat(600); // About 150 tokens.
    await gemini.generateJson('m', { system: '', user: big, schema: {} });
    clock += 1000;
    const second = await gemini.generateJson('m', { system: '', user: big, schema: {} });
    // The second request waits until the first one leaves the one-minute window.
    expect(waits.some((ms) => ms > 58_000 && ms <= 60_001)).toBe(true);
    expect(fake.calls).toHaveLength(2);
    // That wait is reported as waiting, not as model latency (H2 compares latency).
    expect(second.usage.waitedMs).toBeGreaterThan(58_000);
    expect(second.usage.latencyMs).toBe(0);
  });

  it('paces requests to the configured rate', async () => {
    const { gemini, waits } = client([jsonReply('{}'), jsonReply('{}')], {
      maxRequestsPerMinute: 60,
    });
    await gemini.generateJson('m', { system: 's', user: 'u', schema: {} });
    await gemini.generateJson('m', { system: 's', user: 'u', schema: {} });
    expect(waits.some((ms) => ms > 900 && ms <= 1000)).toBe(true);
  });
});
