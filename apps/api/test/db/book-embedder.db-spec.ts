import { Pool } from 'pg';
import { deterministicUuid } from '../../src/common/deterministic-id';
import {
  BookEmbedder,
  EMBEDDING_DIMENSIONS,
  embeddingModelKey,
} from '../../src/representation/book-embedder';
import { EditionEvidenceRepository } from '../../src/representation/edition-evidence.repository';
import { TEST_DATABASE_URL } from './test-database';

/**
 * BE-12: vectors are stored in pgvector under a model key, re-runs skip
 * books that already have one, and similarity search works. The embedding
 * service is a fake that returns fixed vectors, so no API key is needed.
 */
let pool: Pool;

const id = (name: string) => deterministicUuid(`test:be12:${name}`);
const books = ['space', 'space2', 'romance'] as const;

/** Unit vector pointing mostly along one axis. */
function axis(index: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[index] = 1;
  return v;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await pool.query(
    `INSERT INTO works (id, title, created_at, updated_at) VALUES ($1, 'BE-12 work', now(), now())
     ON CONFLICT DO NOTHING`,
    [id('work')],
  );
  for (const name of books) {
    await pool.query(
      `INSERT INTO editions (id, work_id, title, description, normalized_title, normalized_authors,
         metadata_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $3, '', now() + interval '1 day', now()) ON CONFLICT DO NOTHING`,
      [id(name), id('work'), `be12-${name}`, `A book about ${name}.`],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

function fakeEmbedClient() {
  const requests: string[][] = [];
  return {
    requests,
    client: {
      embed: async (_model: string, texts: string[]) => {
        requests.push(texts);
        // "space" books point the same way; the romance book points elsewhere.
        const vectors = texts.map((t) => (t.includes('romance') ? axis(1) : axis(0)));
        return {
          vectors,
          usage: { model: 'fake', inputTokens: 0, outputTokens: 0, latencyMs: 1, waitedMs: 0 },
        };
      },
    },
  };
}

function embedder(client: ReturnType<typeof fakeEmbedClient>['client'], model = 'fake-embedding') {
  return new BookEmbedder(pool, new EditionEvidenceRepository(pool), client, {
    model,
    batchSize: 2,
    maxReviews: 5,
    maxChars: 5000,
    candidateLimit: 50,
    selection: {
      maxReviews: 5,
      minChars: 10,
      maxChars: 500,
      languages: ['en'],
      detectLanguage: () => 'en',
    },
  });
}

describe('BE-12: book embeddings', () => {
  it('stores one vector per edition under a key naming model, size and text recipe', async () => {
    const { client, requests } = fakeEmbedClient();
    const report = await embedder(client).embedMissing(1000);
    expect(report.modelKey).toBe('fake-embedding:768:text-v1');
    expect(report.stoppedBecause).toBeNull();
    expect(requests.every((batch) => batch.length <= 2)).toBe(true);
    const rows = await pool.query(
      `SELECT edition_id, vector_dims(embedding) AS dims FROM book_embeddings
       WHERE embedding_model = $1 AND edition_id = ANY($2::uuid[])`,
      [embeddingModelKey('fake-embedding'), books.map((b) => id(b))],
    );
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.every((r: { dims: number }) => r.dims === 768)).toBe(true);
  });

  it('stores vectors scaled to length 1', async () => {
    const rows = await pool.query<{ norm: number }>(
      `SELECT vector_norm(embedding) AS norm FROM book_embeddings WHERE edition_id = $1 AND embedding_model = $2`,
      [id('space'), embeddingModelKey('fake-embedding')],
    );
    expect(rows.rows[0]!.norm).toBeCloseTo(1, 6);
  });

  it('skips editions that already have a vector for the same key', async () => {
    const { client, requests } = fakeEmbedClient();
    await embedder(client).embedMissing(1000);
    // Other test files add books in parallel, so only this file's books are checked.
    expect(requests.flat().some((text) => text.includes('be12-'))).toBe(false);
  });

  it('keeps vectors from a different model key separate', async () => {
    const { client } = fakeEmbedClient();
    const report = await embedder(client, 'other-embedding').embedMissing(1000);
    expect(report.embedded).toBeGreaterThanOrEqual(3);
  });

  it('finds the most similar book by cosine distance', async () => {
    const result = await pool.query<{ title: string }>(
      `SELECT e.title FROM book_embeddings b JOIN editions e ON e.id = b.edition_id
       WHERE b.embedding_model = $1 AND b.edition_id <> $2 AND e.title LIKE 'be12-%'
       ORDER BY b.embedding <=> (SELECT embedding FROM book_embeddings WHERE edition_id = $2 AND embedding_model = $1)
       LIMIT 1`,
      [embeddingModelKey('fake-embedding'), id('space')],
    );
    expect(result.rows[0]!.title).toBe('be12-space2');
  });

  it('stops cleanly and keeps stored vectors when the service fails', async () => {
    await pool.query(
      `INSERT INTO editions (id, work_id, title, normalized_title, normalized_authors, metadata_expires_at, updated_at)
       VALUES ($1, $2, 'be12-late', 'be12 late', '', now() + interval '1 day', now()) ON CONFLICT DO NOTHING`,
      [id('late'), id('work')],
    );
    const { LlmError } = await import('../../src/llm/gemini.client');
    const failing = {
      embed: async () => {
        throw new LlmError('quota', 'daily quota used up', 3600);
      },
    };
    const report = await embedder(failing as never).embedMissing(1000);
    expect(report.stoppedBecause).toBe('quota: daily quota used up');
    expect(report.embedded).toBe(0);
  });
});
