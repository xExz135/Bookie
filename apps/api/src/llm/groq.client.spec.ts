import { LlmError } from './gemini.client';
import { extractJsonText, GroqClient } from './groq.client';

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function client(replies: Reply[], overrides: Partial<ConstructorParameters<typeof GroqClient>[0]> = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> =
    [];
  const waits: number[] = [];
  const groq = new GroqClient({
    apiKey: 'test-key',
    timeoutMs: 1000,
    maxRequestsPerMinute: 60_000,
    transientRetries: 1,
    fetchImpl: (async (url: string, init: RequestInit) => {
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
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });
  return { groq, calls, waits };
}

const answer = (content: string): Reply => ({
  status: 200,
  body: {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1307, completion_tokens: 40 },
  },
});

const request = {
  system: 'Read covers.',
  user: 'Read this book cover.',
  schema: { type: 'object' },
  images: [{ mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) }],
};

describe('GroqClient (D-030)', () => {
  it('sends the key in a header, the photo inline, and the schema in the prompt', async () => {
    const { groq, calls } = client([answer('{"title":"Dune"}')]);
    const result = await groq.generateJson('qwen/model', request);

    expect(result.text).toBe('{"title":"Dune"}');
    expect(result.usage).toMatchObject({ model: 'qwen/model', inputTokens: 1307, outputTokens: 40 });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(call.url).not.toContain('test-key');
    expect(call.headers.Authorization).toBe('Bearer test-key');
    const [system, user] = call.body.messages as Array<{ role: string; content: unknown }>;
    expect(system!.content).toContain('Read covers.');
    expect(system!.content).toContain('{"type":"object"}');
    expect(user!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } },
      { type: 'text', text: 'Read this book cover.' },
    ]);
    expect(call.body.temperature).toBe(0);
  });

  it('reports a missing key without calling Groq', async () => {
    const { groq, calls } = client([], { apiKey: undefined });
    await expect(groq.generateJson('m', request)).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(0);
  });

  it('does not wait out a rate limit, so the scan can fall back at once', async () => {
    const { groq, calls, waits } = client([
      { status: 429, body: { error: { message: 'Rate limit reached' } }, headers: { 'retry-after': '7' } },
    ]);
    const error = await groq.generateJson('m', request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'quota', retryAfterSeconds: 7 });
    expect(calls).toHaveLength(1);
    expect(waits).toHaveLength(0);
  });

  it('retries an unavailable service once', async () => {
    const { groq, calls } = client([
      { status: 503, body: { error: { message: 'over capacity' } } },
      answer('{}'),
    ]);
    await expect(groq.generateJson('m', request)).resolves.toMatchObject({ text: '{}' });
    expect(calls).toHaveLength(2);
  });

  it('maps errors to the shared kinds', async () => {
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [400, 'invalid_request'],
      [404, 'invalid_request'],
      [498, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const { groq } = client([
        { status, body: { error: { message: 'nope' } } },
        { status, body: { error: { message: 'nope' } } },
      ]);
      await expect(groq.generateJson('m', request)).rejects.toMatchObject({ kind });
    }
  });

  it('treats an empty answer as no usable output', async () => {
    const { groq } = client([answer('   ')]);
    await expect(groq.generateJson('m', request)).rejects.toMatchObject({ kind: 'blocked' });
  });
});

describe('extractJsonText', () => {
  it('takes the JSON object out of a code fence or after a reasoning block', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('<think>{"draft":true} hmm</think>\n{"a":1}')).toBe('{"a":1}');
    expect(extractJsonText('no json here')).toBe('no json here');
  });
});
