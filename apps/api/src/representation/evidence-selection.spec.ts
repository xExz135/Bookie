import { buildEmbeddingText, plainText } from './book-text';
import {
  type CandidateReview,
  type SelectionOptions,
  selectEvidence,
  sentimentOf,
  truncate,
} from './evidence-selection';

const long = (words: string) => `${words} `.repeat(12).trim();

function review(
  id: string,
  rating: number | null,
  text: string,
  sourceKey = 'goodreads_dataset',
): CandidateReview {
  return { id, rating, text, sourceKey };
}

const options: SelectionOptions = {
  maxReviews: 10,
  minChars: 40,
  maxChars: 200,
  languages: ['en'],
  // Test double: anything starting with "ES" is Spanish, everything else English.
  detectLanguage: (text) => (text.startsWith('ES') ? 'es' : 'en'),
};

describe('selectEvidence (spec 8)', () => {
  it('drops short, duplicate and other-language reviews', () => {
    const result = selectEvidence(
      [
        review('a', 5, 'Too short.'),
        review('b', 5, long('A lovely, moving story')),
        review('c', 4, long('a lovely moving story!')), // Same text once normalised.
        review('d', 1, long('ES Una historia muy aburrida')),
      ],
      options,
    );
    expect(result.selected.map((r) => r.id)).toEqual(['b']);
    expect(result.dropped).toEqual({ tooShort: 1, duplicate: 1, language: 1, overLimit: 0 });
  });

  it('drops reviews whose language cannot be detected', () => {
    const result = selectEvidence([review('a', 5, long('Fine'))], {
      ...options,
      detectLanguage: () => null,
    });
    expect(result.selected).toHaveLength(0);
    expect(result.dropped.language).toBe(1);
  });

  it('balances complaints and praise when praise dominates', () => {
    const reviews = [
      ...Array.from({ length: 8 }, (_, i) => review(`p${i}`, 5, long(`Praise number ${i}`))),
      review('n1', 1, long('Complaint one')),
      review('n2', 2, long('Complaint two')),
      review('m1', 3, long('Mixed feelings')),
    ];
    const { selected } = selectEvidence(reviews, { ...options, maxReviews: 5 });
    expect(selected.map((r) => r.sentiment)).toEqual([
      'negative',
      'positive',
      'mixed',
      'negative',
      'positive',
    ]);
  });

  it('numbers the selected reviews 1..N and caps the count', () => {
    const reviews = Array.from({ length: 30 }, (_, i) =>
      review(`r${String(i).padStart(2, '0')}`, 4, long(`Review ${i}`)),
    );
    const { selected, dropped } = selectEvidence(reviews, { ...options, maxReviews: 7 });
    expect(selected.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dropped.overLimit).toBe(23);
  });

  it('applies a per-source limit', () => {
    const reviews = [
      ...Array.from({ length: 5 }, (_, i) => review(`a${i}`, 4, long(`Source A ${i}`), 'a')),
      ...Array.from({ length: 5 }, (_, i) => review(`b${i}`, 4, long(`Source B ${i}`), 'b')),
    ];
    const { selected } = selectEvidence(reviews, { ...options, perSourceLimit: 2 });
    expect(selected.filter((r) => r.sourceKey === 'a')).toHaveLength(2);
    expect(selected.filter((r) => r.sourceKey === 'b')).toHaveLength(2);
  });

  it('MODEL-1: gives the same set in the same order whatever the input order', () => {
    const reviews = Array.from({ length: 20 }, (_, i) =>
      review(`r${i}`, (i % 5) + 1, long(`Text ${i}`)),
    );
    const a = selectEvidence(reviews, options).selected;
    const b = selectEvidence([...reviews].reverse(), options).selected;
    expect(b).toEqual(a);
  });

  it('truncates long reviews at a word boundary and marks them', () => {
    const { selected } = selectEvidence([review('a', 4, long('Wonderfully written prose'))], {
      ...options,
      maxChars: 60,
    });
    expect(selected[0]!.text.length).toBeLessThanOrEqual(60);
    expect(selected[0]!.text.endsWith('…')).toBe(true);
    expect(selected[0]!.truncated).toBe(true);
  });
});

describe('helpers', () => {
  it.each([
    [5, 'positive'],
    [4, 'positive'],
    [3, 'mixed'],
    [2, 'negative'],
    [1, 'negative'],
    [null, 'unrated'],
  ] as const)('rating %s is %s', (rating, sentiment) => {
    expect(sentimentOf(rating)).toBe(sentiment);
  });

  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toEqual({ text: 'short', truncated: false });
  });

  it('strips HTML from descriptions', () => {
    expect(plainText('<b>Bold</b> and<br/>more &amp; <i>more</i>')).toBe('Bold and more & more');
  });
});

describe('buildEmbeddingText (spec 7)', () => {
  const book = {
    title: 'T',
    authors: ['A', 'B'],
    genres: ['fiction'],
    description: '<p>About</p>',
  };
  const selected = selectEvidence(
    [
      review('a', 5, long('Great book about things')),
      review('b', 1, long('Dull book about stuff')),
    ],
    options,
  ).selected;

  it('combines metadata, description and selected reviews', () => {
    expect(buildEmbeddingText(book, selected, { maxReviews: 5, maxChars: 10_000 })).toBe(
      [
        'Title: T',
        'Authors: A, B',
        'Genres: fiction',
        'Description: About',
        'Reader reviews:',
        `- ${selected[0]!.text}`,
        `- ${selected[1]!.text}`,
      ].join('\n'),
    );
  });

  it('respects the review and length limits', () => {
    const text = buildEmbeddingText(book, selected, { maxReviews: 1, maxChars: 40 });
    expect(text.length).toBeLessThanOrEqual(40);
    expect(buildEmbeddingText(book, selected, { maxReviews: 0, maxChars: 10_000 })).not.toContain(
      'Reader reviews',
    );
  });
});

describe('normalize', () => {
  it('scales a vector to length 1 and keeps its direction', async () => {
    const { normalize } = await import('./book-embedder');
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(() => normalize([0, 0])).toThrow();
  });
});
