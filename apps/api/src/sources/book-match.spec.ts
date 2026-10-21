import { bookIsbns, isbn13Of, matchBook, similarity, titleForms } from './book-match';

const t = { minTitle: 0.75, minAuthor: 0.5 };
const hungerGames = {
  title: 'The Hunger Games',
  authors: ['Suzanne Collins'],
  isbn13: '9780439023481',
  isbn10: null,
};

describe('Matching live source results to the book, in code (D-020)', () => {
  it('computes similarity like PostgreSQL pg_trgm (values from the dev database)', () => {
    expect(similarity('word', 'two words')).toBeCloseTo(0.36363637, 6);
    expect(similarity('the hunger games', 'the hunger games trilogy')).toBeCloseTo(0.7083333, 6);
    expect(similarity('cien años de soledad', 'one hundred years of solitude')).toBeCloseTo(
      0.08695652,
      6,
    );
    expect(similarity('j k rowling', 'joanne rowling')).toBeCloseTo(0.5, 6);
    expect(
      similarity(
        'harry potter and the sorcerer s stone',
        'harry potter and the philosopher s stone',
      ),
    ).toBeCloseTo(0.62222224, 6);
    expect(similarity('', 'anything')).toBe(0);
  });

  it('compares titles with and without subtitle, series marker and alternative title', () => {
    expect(titleForms('The Hobbit, or There and Back Again')).toContain('The Hobbit');
    expect(titleForms('Frankenstein; or, The Modern Prometheus')).toContain('Frankenstein');
    expect(titleForms('The Employees: A Workplace Novel')).toContain('The Employees');
    expect(titleForms('Catching Fire (The Hunger Games, #2)')).toContain('Catching Fire');
    // "or" inside a word is not an alternative title.
    expect(titleForms('Gods, Oracles and Men')).toEqual(['Gods, Oracles and Men']);
  });

  it('needs both title and author: a fuzzy hit with the right title by someone else is rejected', () => {
    const quizBook = { titles: ['THE HUNGER GAMES'], authors: ['Narayan Changder'], isbns: [] };
    expect(matchBook(hungerGames, quizBook, t)).toBeNull();
    const meadows = { titles: ['The Meadows'], authors: ['Stephanie Oakes'], isbns: [] };
    expect(
      matchBook(
        { title: 'Zxqv Plorbing Meadows', authors: [], isbn13: null, isbn10: null },
        meadows,
        t,
      ),
    ).toBeNull();
  });

  it('checks the title even when the ISBN agrees (Open Library ISBN lookups can return another book)', () => {
    const other = {
      titles: ['Retrospectiva'],
      authors: ['Museo Castagnino'],
      isbns: ['9780439023481'],
    };
    expect(matchBook(hungerGames, other, t)).toBeNull();
  });

  it('keeps box sets out at the default threshold and ranks an ISBN match above a title-only match', () => {
    const boxSet = {
      titles: ['The Hunger Games Trilogy'],
      authors: ['Suzanne Collins'],
      isbns: [],
    };
    expect(matchBook(hungerGames, boxSet, t)).toBeNull();
    const plain = matchBook(
      hungerGames,
      { titles: ['The Hunger Games'], authors: ['Suzanne Collins'], isbns: [] },
      t,
    );
    const withIsbn = matchBook(
      hungerGames,
      { titles: ['The Hunger Games'], authors: ['Suzanne Collins'], isbns: ['0439023483'] },
      t,
    );
    expect(plain).toMatchObject({ isbnMatch: false });
    expect(withIsbn).toMatchObject({ isbnMatch: true });
    expect(withIsbn!.score).toBeGreaterThan(plain!.score);
  });

  it('matches across languages through an edition title, and refuses a candidate without authors', () => {
    const spanish = {
      title: 'Cien años de soledad',
      authors: ['Gabriel García Márquez'],
      isbn13: null,
      isbn10: null,
    };
    const hardcover = {
      titles: ['One Hundred Years of Solitude', 'Cien años de soledad'],
      authors: ['Gabriel García Márquez'],
      isbns: [],
    };
    expect(matchBook(spanish, hardcover, t)).not.toBeNull();
    expect(matchBook(spanish, { ...hardcover, authors: [] }, t)).toBeNull();
  });

  it('converts ISBN-10 to ISBN-13 and rejects malformed numbers', () => {
    expect(isbn13Of('0439023483')).toBe('9780439023481');
    expect(isbn13Of('978-0-439-02348-1')).toBe('9780439023481');
    expect(isbn13Of('043902348X')).toMatch(/^978043902348\d$/);
    expect(isbn13Of('12345')).toBeNull();
    expect(bookIsbns({ isbn13: '9780439023481', isbn10: '0439023483' })).toEqual(['9780439023481']);
  });
});
