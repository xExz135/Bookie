import { CoverReadError, parseCoverReading, readCover } from './cover-reader';
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
