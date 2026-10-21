import { parseCsv } from './csv';
import { parseRatingFile } from './rating-file';

const GOODREADS_HEADER =
  'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies';

function goodreadsRow(f: {
  id: string;
  title: string;
  author: string;
  isbn?: string;
  isbn13?: string;
  rating: number;
  shelf?: string;
  review?: string;
  notes?: string;
}): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    f.id,
    q(f.title),
    f.author,
    q(f.author.split(' ').reverse().join(', ')),
    '',
    q(`=${q(f.isbn ?? '')}`),
    q(`=${q(f.isbn13 ?? '')}`),
    f.rating,
    '4.10',
    'Some Publisher',
    'Paperback',
    '300',
    '2008',
    '2008',
    '2020/01/02',
    '2019/12/01',
    '',
    '',
    f.shelf ?? 'read',
    q(f.review ?? ''),
    '',
    q(f.notes ?? ''),
    '1',
    '0',
  ].join(',');
}

const goodreadsFile = (...rows: string[]) =>
  Buffer.from([GOODREADS_HEADER, ...rows].join('\r\n'), 'utf8');

describe('CSV parsing', () => {
  it('handles quoted commas, doubled quotes, line breaks inside quotes, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n1,"two, 2","say ""hi""\nthere"\n\n4,,6';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, 2', 'say "hi"\nthere'],
      ['4', '', '6'],
    ]);
  });

  it('stops after the record limit', () => {
    expect(parseCsv('a\nb\nc\nd', 2)).toEqual([['a'], ['b']]);
  });
});

describe('rating export files (ONB-1)', () => {
  it('reads a Goodreads export: ratings only, series removed, ISBNs unwrapped', () => {
    const result = parseRatingFile(
      goodreadsFile(
        goodreadsRow({
          id: '2767052',
          title: 'The Hunger Games (The Hunger Games, #1)',
          author: 'Suzanne Collins',
          isbn: '0439023483',
          isbn13: '9780439023481',
          rating: 5,
          review: 'Loved it, truly.\nSecond line of my private review.',
          notes: 'Lent to Sam',
        }),
        goodreadsRow({
          id: '1',
          title: 'Not Rated Yet',
          author: 'A B',
          rating: 0,
          shelf: 'to-read',
        }),
        goodreadsRow({ id: '3', title: 'No ISBN', author: 'C D', rating: 2 }),
      ),
      100,
    );
    expect(result).toEqual({
      ok: true,
      format: 'goodreads',
      ignored: 1,
      rows: [
        {
          rowIndex: 1,
          title: 'The Hunger Games',
          author: 'Suzanne Collins',
          rating: 5,
          goodreadsBookId: '2767052',
          isbn13: '9780439023481',
          isbn10: '0439023483',
        },
        {
          rowIndex: 2,
          title: 'No ISBN',
          author: 'C D',
          rating: 2,
          goodreadsBookId: '3',
          isbn13: null,
          isbn10: null,
        },
      ],
    });
    // Reviews and notes are never part of what is kept.
    expect(JSON.stringify(result)).not.toContain('private review');
    expect(JSON.stringify(result)).not.toContain('Lent to Sam');
  });

  it('reads a StoryGraph export, rounding quarter stars to whole stars', () => {
    const csv = [
      'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Character- or Plot-Driven?,Strong Character Development?,Loveable Characters?,Diverse Characters?,Flawed Characters?,Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?',
      'Project Hail Mary,"Andy Weir, Someone Else",,9780593135204,hardcover,read,2021/06/01,,,1,,,,,,,,4.5,"great, fun",,,,No',
      'Piranesi,Susanna Clarke,,9781635575637,paperback,read,2021/06/01,,,1,,,,,,,,3.25,,,,,No',
      'Some Unread Book,Anyone,,,ebook,to-read,2021/06/01,,,0,,,,,,,,,,,,,No',
      'Tiny,Small Author,,,ebook,read,2021/06/01,,,1,,,,,,,,0.25,,,,,No',
    ].join('\n');
    const result = parseRatingFile(Buffer.from(csv), 100);
    expect(result.ok && result.format).toBe('storygraph');
    if (!result.ok) return;
    expect(result.ignored).toBe(1);
    expect(result.rows.map((r) => [r.title, r.author, r.rating, r.isbn13])).toEqual([
      ['Project Hail Mary', 'Andy Weir', 5, '9780593135204'],
      ['Piranesi', 'Susanna Clarke', 3, '9781635575637'],
      ['Tiny', 'Small Author', 1, null],
    ]);
  });

  it('rejects files that are not a known export', () => {
    expect(parseRatingFile(Buffer.from('name,score\nx,1'), 100)).toEqual({
      ok: false,
      reason: 'unknown_format',
    });
    expect(parseRatingFile(Buffer.from([0xff, 0xfe, 0x00, 0x41]), 100)).toEqual({
      ok: false,
      reason: 'not_text',
    });
    expect(parseRatingFile(Buffer.from('%PDF-1.7\u0000binary'), 100)).toEqual({
      ok: false,
      reason: 'not_text',
    });
  });

  it('rejects a file with no rated books, or too many', () => {
    expect(
      parseRatingFile(
        goodreadsFile(goodreadsRow({ id: '1', title: 'T', author: 'A', rating: 0 })),
        100,
      ),
    ).toEqual({ ok: false, reason: 'no_ratings' });
    const many = Array.from({ length: 4 }, (_, i) =>
      goodreadsRow({ id: String(i + 1), title: `Book ${i}`, author: 'A', rating: 3 }),
    );
    expect(parseRatingFile(goodreadsFile(...many), 3)).toEqual({
      ok: false,
      reason: 'too_many_rows',
    });
  });
});
