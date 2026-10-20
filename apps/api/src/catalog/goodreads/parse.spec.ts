import { deterministicUuid } from '../../common/deterministic-id';
import { toBcp47 } from '../language';
import { cleanText, normalizeForSearch } from '../normalize';
import { csvLine } from './io';
import {
  ids,
  parseAuthor,
  parseBook,
  parseGenres,
  parseGoodreadsDate,
  parseReview,
  parseWork,
  stripSeriesMarker,
} from './parse';

describe('stripSeriesMarker', () => {
  it.each([
    ['The Hunger Games (The Hunger Games, #1)', 'The Hunger Games'],
    ['Small Gods (Discworld, #13.5)', 'Small Gods'],
    ['The Unschooled Wizard (Sun Wolf and Starhawk, #1-2)', 'The Unschooled Wizard'],
    ['Crowner Royal (Crowner John Mystery #13)', 'Crowner Royal'],
    ['Ranma ½, Vol. 1 (Ranma ½ (US 2nd), #1)', 'Ranma ½, Vol. 1'],
    ['Catch-22', 'Catch-22'],
    ['Persuasion (Penguin Classics)', 'Persuasion (Penguin Classics)'],
    ['(Series, #1)', '(Series, #1)'],
  ])('%s -> %s', (input, expected) => {
    expect(stripSeriesMarker(input)).toBe(expected);
  });
});

describe('normalizeForSearch', () => {
  it('lowercases, strips accents and turns punctuation into single spaces', () => {
    expect(normalizeForSearch('  Cien años de Soledad: Édition (2nd)!  ')).toBe(
      'cien anos de soledad edition 2nd',
    );
  });

  it('keeps letters from other scripts', () => {
    expect(normalizeForSearch('ノルウェイの森')).toBe('ノルウェイの森');
  });
});

describe('cleanText', () => {
  it('trims, removes NUL characters and turns blanks into null', () => {
    expect(cleanText(' a\u0000b ')).toBe('ab');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });
});

describe('toBcp47', () => {
  it.each([
    ['eng', 'en'],
    ['spa', 'es'],
    ['en-us', 'en-US'],
    ['en-GB', 'en-GB'],
    ['nl', 'nl'],
    ['fil', 'fil'],
    ['mul', null],
    ['', null],
    ['not a code', null],
  ])('%s -> %s', (input, expected) => {
    expect(toBcp47(input)).toBe(expected);
  });
});

describe('deterministicUuid', () => {
  it('is a valid version 5 UUID and stable for the same name', () => {
    const a = deterministicUuid('goodreads:book:1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid('goodreads:book:1')).toBe(a);
    expect(deterministicUuid('goodreads:book:2')).not.toBe(a);
  });

  it('gives different IDs to different kinds of record with the same Goodreads ID', () => {
    expect(ids.book('7')).not.toBe(ids.work('7'));
  });
});

describe('csvLine', () => {
  it('quotes values, doubles quotes and leaves null unquoted', () => {
    expect(csvLine(['a "b"', null, 3, 'x,y\nz'])).toBe('"a ""b""",,"3","x,y\nz"\n');
  });

  it('writes an empty string as "" so it is not read as NULL', () => {
    expect(csvLine([''])).toBe('""\n');
  });
});

describe('parseGoodreadsDate', () => {
  it('reads the dataset format with its time-zone offset', () => {
    expect(parseGoodreadsDate('Fri Aug 25 13:55:02 -0700 2017')?.toISOString()).toBe(
      '2017-08-25T20:55:02.000Z',
    );
  });

  it('returns null for blanks and unknown formats', () => {
    expect(parseGoodreadsDate('')).toBeNull();
    expect(parseGoodreadsDate('2017-08-25')).toBeNull();
  });
});

describe('parseBook', () => {
  const raw = {
    book_id: '100',
    work_id: '900',
    title: 'The Example (Series, #1)',
    title_without_series: 'The Example',
    authors: [
      { author_id: '1', role: '' },
      { author_id: '2', role: 'Translator' },
      { author_id: '1', role: 'Editor' },
    ],
    language_code: 'eng',
    publisher: ' Some Press ',
    publication_year: '2009',
    format: 'Paperback',
    num_pages: '320',
    isbn: '0-312-85312-2',
    isbn13: '9780312853129',
    image_url: 'https://images.gr-assets.com/books/1/100.jpg',
    description: '',
    average_rating: '4.126',
    ratings_count: '57',
  };

  it('maps the edition fields', () => {
    const book = parseBook(raw)!;
    expect(book.edition).toMatchObject({
      id: ids.book('100'),
      title: 'The Example',
      language: 'en',
      publisher: 'Some Press',
      publicationYear: 2009,
      format: 'Paperback',
      pageCount: 320,
      isbn10: '0312853122',
      isbn13: '9780312853129',
      description: null,
      normalizedTitle: 'the example',
    });
    expect(book.workExternalId).toBe('900');
  });

  it('keeps the first role of a repeated author and numbers authors in order', () => {
    expect(parseBook(raw)!.authors).toEqual([
      { externalId: '1', position: 1, role: null },
      { externalId: '2', position: 2, role: 'Translator' },
    ]);
  });

  it('keeps a rating summary only when there are ratings in range', () => {
    expect(parseBook(raw)!.ratingSummary).toEqual({
      id: ids.ratingSummary('100'),
      average: 4.13,
      count: 57,
    });
    expect(parseBook({ ...raw, ratings_count: '0' })!.ratingSummary).toBeNull();
    expect(parseBook({ ...raw, average_rating: '0.00' })!.ratingSummary).toBeNull();
  });

  it('drops the Goodreads "nophoto" placeholder cover', () => {
    const book = parseBook({
      ...raw,
      image_url: 'https://s.gr-assets.com/assets/nophoto/book/111x148.png',
    });
    expect(book!.edition.coverUrl).toBeNull();
  });

  it('turns invalid numbers and ISBNs into null', () => {
    const book = parseBook({
      ...raw,
      publication_year: '20',
      num_pages: 'abc',
      isbn: '123',
      isbn13: '',
    })!;
    expect(book.edition).toMatchObject({
      publicationYear: null,
      pageCount: null,
      isbn10: null,
      isbn13: null,
    });
  });

  it('skips a book without an ID or title', () => {
    expect(parseBook({ ...raw, book_id: '' })).toBeNull();
    expect(parseBook({ ...raw, title: '', title_without_series: ' ' })).toBeNull();
  });
});

describe('parseAuthor, parseWork, parseGenres', () => {
  it('maps an author with a search name', () => {
    expect(parseAuthor({ author_id: '5', name: 'Gabriel García Márquez' })).toEqual({
      id: ids.author('5'),
      externalId: '5',
      name: 'Gabriel García Márquez',
      normalizedName: 'gabriel garcia marquez',
    });
  });

  it('skips a work without a title', () => {
    expect(parseWork({ work_id: '9', original_title: '' })).toBeNull();
    expect(
      parseWork({ work_id: '9', original_title: 'T', original_publication_year: '1967' }),
    ).toMatchObject({
      originalPublicationYear: 1967,
    });
  });

  it('lists genre votes', () => {
    expect(parseGenres({ book_id: '1', genres: { fiction: 3, romance: 1 } })).toEqual([
      { bookExternalId: '1', genre: 'fiction', votes: 3 },
      { bookExternalId: '1', genre: 'romance', votes: 1 },
    ]);
  });
});

describe('parseReview', () => {
  const raw = {
    review_id: 'r1',
    book_id: '100',
    user_id: 'u1',
    rating: 4,
    review_text: ' Loved it ',
    date_added: 'Fri Aug 25 13:55:02 -0700 2017',
  };

  it('maps a review', () => {
    expect(parseReview(raw)).toMatchObject({
      id: ids.review('r1'),
      rating: 4,
      text: 'Loved it',
      textLength: 8,
      reviewerExternalId: 'u1',
    });
  });

  it('treats rating 0 as "no rating"', () => {
    expect(parseReview({ ...raw, rating: 0 })!.rating).toBeNull();
  });

  it('keeps a rating without text as a rating-only review', () => {
    expect(parseReview({ ...raw, review_text: '' })).toMatchObject({
      rating: 4,
      text: '',
      textLength: 0,
    });
  });

  it('skips a review with neither rating nor text', () => {
    expect(parseReview({ ...raw, rating: 0, review_text: '  ' })).toBeNull();
  });
});
