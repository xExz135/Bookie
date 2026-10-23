import { LlmError } from '../llm/gemini.client';
import {
  CoverReadError,
  parseCoverReading,
  readCover,
  readCoverWithFallback,
} from './cover-reader';
import { buildVisionReaders, visionOrder } from './cover-vision';
import { parseIsbn } from './catalog-search';

const valid = {
  isBook: true,
  readable: true,
  title: '  PROJECT   HAIL MARY ',
  subtitle: '',
  authors: ['ANDY WEIR', ''],
  certainty: 'high',
};

describe('cover reading output checks', () => {
  it('accepts the expected shape and tidies the text', () => {
    expect(parseCoverReading(JSON.stringify(valid))).toEqual({
      isBook: true,
      readable: true,
      title: 'PROJECT HAIL MARY',
      subtitle: '',
      authors: ['ANDY WEIR'],
      certainty: 'high',
    });
  });

  it('is never readable without a title, whatever the model says', () => {
    expect(parseCoverReading(JSON.stringify({ ...valid, title: '   ' }))?.readable).toBe(false);
  });

  it('rejects other shapes', () => {
    for (const bad of [
      'not json',
      '{}',
      JSON.stringify({ ...valid, certainty: 'very high' }),
      JSON.stringify({ ...valid, authors: 'ANDY WEIR' }),
      JSON.stringify({ ...valid, isBook: 'yes' }),
    ]) {
      expect(parseCoverReading(bad)).toBeNull();
    }
  });

  it('retries invalid output once, then fails', async () => {
    const usage = { model: 'v', inputTokens: 1, outputTokens: 1, latencyMs: 1, waitedMs: 0 };
    const replies = ['nonsense', JSON.stringify(valid)];
    const client = { generateJson: jest.fn(async () => ({ text: replies.shift()!, usage })) };
    const image = { mimeType: 'image/jpeg', data: Buffer.from([1]) };

    const ok = await readCover(client, 'v', image);
    expect(ok.reading.title).toBe('PROJECT HAIL MARY');
    expect(client.generateJson).toHaveBeenCalledTimes(2);

    const broken = { generateJson: jest.fn(async () => ({ text: 'nonsense', usage })) };
    await expect(readCover(broken, 'v', image)).rejects.toBeInstanceOf(CoverReadError);
    expect(broken.generateJson).toHaveBeenCalledTimes(2);
  });
});

describe('cover reading with a backup provider (D-030)', () => {
  const usage = { model: 'v', inputTokens: 1, outputTokens: 1, latencyMs: 1, waitedMs: 0 };
  const image = { mimeType: 'image/jpeg', data: Buffer.from([1]) };
  const answers = (text: string) => ({ generateJson: jest.fn(async () => ({ text, usage })) });
  const fails = (error: Error) => ({
    generateJson: jest.fn(async (): Promise<{ text: string; usage: typeof usage }> => {
      throw error;
    }),
  });

  it('uses the first provider when it answers, and never asks the backup', async () => {
    const groq = answers(JSON.stringify(valid));
    const gemini = answers(JSON.stringify(valid));
    const result = await readCoverWithFallback(
      [
        { provider: 'groq', model: 'g', client: groq },
        { provider: 'gemini', model: 'm', client: gemini },
      ],
      image,
    );
    expect(result.provider).toBe('groq');
    expect(groq.generateJson).toHaveBeenCalledWith('g', expect.anything());
    expect(gemini.generateJson).not.toHaveBeenCalled();
  });

  it('keeps a "not a book" answer instead of asking the backup', async () => {
    const gemini = answers(JSON.stringify(valid));
    const result = await readCoverWithFallback(
      [
        {
          provider: 'groq',
          model: 'g',
          client: answers(JSON.stringify({ ...valid, isBook: false })),
        },
        { provider: 'gemini', model: 'm', client: gemini },
      ],
      image,
    );
    expect(result.reading.isBook).toBe(false);
    expect(gemini.generateJson).not.toHaveBeenCalled();
  });

  it('falls back on a service failure or invalid output, and reports each failure', async () => {
    for (const first of [
      fails(new LlmError('quota', 'rate limited')),
      fails(new LlmError('auth', 'GROQ_API_KEY is not set')),
      answers('nonsense'),
    ]) {
      const failures: string[] = [];
      const result = await readCoverWithFallback(
        [
          { provider: 'groq', model: 'g', client: first },
          { provider: 'gemini', model: 'm', client: answers(JSON.stringify(valid)) },
        ],
        image,
        (reader) => failures.push(reader.provider),
      );
      expect(result.provider).toBe('gemini');
      expect(failures).toEqual(['groq']);
    }
  });

  it('throws the last error when every provider fails', async () => {
    await expect(
      readCoverWithFallback(
        [
          { provider: 'groq', model: 'g', client: fails(new LlmError('quota', 'rate limited')) },
          { provider: 'gemini', model: 'm', client: fails(new LlmError('unavailable', 'down')) },
        ],
        image,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('does not swallow programming errors', async () => {
    const gemini = answers(JSON.stringify(valid));
    await expect(
      readCoverWithFallback(
        [
          { provider: 'groq', model: 'g', client: fails(new TypeError('bug')) },
          { provider: 'gemini', model: 'm', client: gemini },
        ],
        image,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(gemini.generateJson).not.toHaveBeenCalled();
  });
});

describe('which providers read covers (D-030)', () => {
  const config = {
    SCAN_VISION_PROVIDER: 'groq' as const,
    SCAN_VISION_FALLBACK: true,
    SCAN_TIMEOUT_MS: 1000,
    GROQ_API_KEY: 'groq-key',
    GROQ_VISION_MODEL: 'groq-model',
    GROQ_MAX_REQUESTS_PER_MINUTE: 30,
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_VISION_MODEL: 'gemini-model',
    GEMINI_MAX_REQUESTS_PER_MINUTE: 30,
    GEMINI_TOKENS_PER_MINUTE: 30_000,
  };

  it('tries the chosen provider first, then the other one', () => {
    expect(visionOrder(config)).toEqual(['groq', 'gemini']);
    expect(visionOrder({ ...config, SCAN_VISION_PROVIDER: 'gemini' })).toEqual(['gemini', 'groq']);
    expect(buildVisionReaders(config).map((r) => [r.provider, r.model])).toEqual([
      ['groq', 'groq-model'],
      ['gemini', 'gemini-model'],
    ]);
  });

  it('uses only the chosen provider when fallback is off', () => {
    expect(visionOrder({ ...config, SCAN_VISION_FALLBACK: false })).toEqual(['groq']);
  });

  it('leaves out a provider without a key, but keeps the chosen one if none has a key', () => {
    expect(visionOrder({ ...config, GROQ_API_KEY: undefined })).toEqual(['gemini']);
    expect(visionOrder({ ...config, GEMINI_API_KEY: undefined })).toEqual(['groq']);
    expect(visionOrder({ ...config, GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined })).toEqual(
      ['groq'],
    );
  });
});

describe('ISBN queries', () => {
  it('recognises ISBN-13 and ISBN-10 with hyphens or spaces, and converts ISBN-10', () => {
    expect(parseIsbn('978-0-593-39556-1')).toEqual({ isbn10: null, isbn13: '9780593395561' });
    expect(parseIsbn('0 593 39556 5')).toEqual({ isbn10: '0593395565', isbn13: '9780593395561' });
    expect(parseIsbn('080442957X')).toEqual({ isbn10: '080442957X', isbn13: '9780804429573' });
  });

  it('ignores wrong check digits and ordinary text', () => {
    expect(parseIsbn('9780593395562')).toBeNull();
    expect(parseIsbn('0593395566')).toBeNull();
    expect(parseIsbn('harry potter')).toBeNull();
    expect(parseIsbn('1984')).toBeNull();
  });
});
