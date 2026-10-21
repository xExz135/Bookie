import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { normalizeForSearch } from '../../src/catalog/normalize';
import { LlmError } from '../../src/llm/gemini.client';
import type { BookRef, RatingLookup, RatingSourceAdapter } from '../../src/sources/rating-source';
import { SourceError } from '../../src/sources/source-error';

/**
 * Shared fakes and catalog rows for tests that run the analysis pipeline
 * (BE-8, BE-10): the language model and live sources are fakes, so every
 * outcome can be produced on purpose.
 */

const usage = { model: 'fake', inputTokens: 100, outputTokens: 20, latencyMs: 5, waitedMs: 0 };
export const TRAITS = {
  pace: { value: 'fast', evidence: [1] },
  tone: { value: 'tense', evidence: [2] },
  contentIntensity: { value: 'unknown', evidence: [] },
  themes: [{ value: 'survival', evidence: [1, 3] }],
};
export const SUMMARY = {
  summary: 'Readers found it gripping and fast; a few thought the ending was rushed.',
  praises: [{ text: 'A tense, fast plot.', evidence: [1, 2] }],
  complaints: [{ text: 'The ending felt rushed.', evidence: [3] }],
};

export class FakeLlm {
  calls = { traits: 0, summary: 0 };
  traits: 'ok' | 'invalid' | 'quota' = 'ok';
  summary: 'ok' | 'invalid' | 'quota' = 'ok';
  /** When set, calls wait for it, so a test can see an analysis while it runs. */
  gate: Promise<void> | null = null;
  /** Replaces the traits reply, so two books can differ (compare). */
  traitsReply: object | null = null;

  generateJson = async (_model: string, req: { system: string }) => {
    if (this.gate) await this.gate;
    const kind = req.system.includes("book's traits") ? 'traits' : 'summary';
    this.calls[kind]++;
    const mode = this[kind];
    if (mode === 'quota') throw new LlmError('quota', 'Quota exhausted');
    const reply =
      mode === 'invalid'
        ? { nonsense: true }
        : kind === 'traits'
          ? (this.traitsReply ?? TRAITS)
          : SUMMARY;
    return { text: JSON.stringify(reply), usage };
  };
}

export class FakeSource implements RatingSourceAdapter {
  readonly configured = true;
  asked = 0;
  mode: 'ok' | 'failed' | 'empty' = 'ok';
  constructor(
    readonly key: string,
    private readonly average: number,
    private readonly count: number,
  ) {}
  async lookup(_book: BookRef): Promise<RatingLookup> {
    this.asked++;
    if (this.mode === 'failed') throw new SourceError('failed', 'down', 'network');
    if (this.mode === 'empty') return { outcome: 'empty', reason: 'not_found' };
    return {
      outcome: 'ok',
      ratingAverage: this.average,
      ratingCount: this.count,
      ratingScope: 'work',
      externalId: 'x',
      matchedBy: 'isbn',
    };
  }
}

/** Distinct English reviews long enough to count as evidence. */
export const REVIEW_TEXTS = [
  'The plot moves fast and the tension never lets up, I read the whole thing in one sitting.',
  'Tense and gripping from the first chapter, the characters felt real and their choices mattered.',
  'I liked most of it, but the ending felt rushed and several threads were left hanging at the end.',
  'A survival story that kept me reading late into the night, even though it is quite violent.',
  'The world building is clever and the heroine is brave, though the romance felt forced to me.',
  'Honestly the middle section dragged a little, but the last third of the book was excellent.',
  'Dark themes handled with care, and the writing is simple and clear enough for younger readers.',
  'I did not enjoy it, the narrator annoyed me and the violence seemed pointless most of the time.',
  'One of the best books I read this year, I immediately bought the next one in the series.',
  'Good premise, weak execution, and the dialogue was often clumsy and much too obvious for me.',
  'A strong opening, memorable side characters and a satisfying amount of suspense throughout.',
  'Too predictable for my taste, I guessed every twist long before the characters worked it out.',
];

/** A catalog edition with dataset reviews (and optionally a dataset rating summary). */
export async function insertBook(
  db: Client,
  options: { reviews?: number; description?: string | null; ratings?: number } = {},
): Promise<string> {
  const workId = randomUUID();
  const editionId = randomUUID();
  const title = `Analysis book ${editionId.slice(0, 8)}`;
  await db.query(`INSERT INTO works (id, title, updated_at) VALUES ($1, $2, now())`, [
    workId,
    title,
  ]);
  await db.query(
    `INSERT INTO editions (id, work_id, title, description, language, publication_year, isbn_13, publisher, format,
       page_count, normalized_title, normalized_authors, metadata_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, 'en', 2008, '9780439023481', 'Scholastic Press', 'Hardcover', 374, $5, 'suzanne test',
       now() + interval '30 days', now())`,
    [
      editionId,
      workId,
      title,
      options.description === undefined ? 'A girl fights to survive.' : options.description,
      normalizeForSearch(title),
    ],
  );
  const authorId = randomUUID();
  await db.query(
    `INSERT INTO authors (id, name, normalized_name) VALUES ($1, 'Suzanne Test', 'suzanne test')`,
    [authorId],
  );
  await db.query(
    `INSERT INTO edition_authors (edition_id, author_id, position) VALUES ($1, $2, 1)`,
    [editionId, authorId],
  );
  const reviews = options.reviews ?? 12;
  for (let i = 0; i < reviews; i++) {
    const text = REVIEW_TEXTS[i % REVIEW_TEXTS.length]!;
    await db.query(
      `INSERT INTO reviews (id, edition_id, source_id, external_review_id, rating, text, text_length, language)
       VALUES ($1, $2, (SELECT id FROM review_sources WHERE key = 'goodreads_dataset'), $3, $4, $5, $6, 'en')`,
      [
        randomUUID(),
        editionId,
        `${editionId}-${i}`,
        [5, 4, 2, 4, 3, 4, 4, 1, 5, 2, 4, 2][i % 12],
        text,
        text.length,
      ],
    );
  }
  if (options.ratings !== undefined) {
    await db.query(
      `INSERT INTO review_fetches (id, edition_id, source_id, reviews_version, outcome, rating_average, rating_count, review_count, expires_at)
       VALUES ($1, $2, (SELECT id FROM review_sources WHERE key = 'goodreads_dataset'), 1, 'ok', 4.33, $3, $4, '9999-12-31')`,
      [randomUUID(), editionId, options.ratings, reviews],
    );
  }
  return editionId;
}
