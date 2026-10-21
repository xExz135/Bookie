import type { Pool } from 'pg';
import type { BookForEmbedding } from './book-text';
import type { CandidateReview } from './evidence-selection';

export interface EditionForRepresentation extends BookForEmbedding {
  id: string;
}

/**
 * Reads what the representation needs from the catalog. Reviews are read as
 * a stable sample (ordered by ID) so very popular books do not load tens of
 * thousands of rows and the same sample comes back every time.
 */
export class EditionEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async editions(ids: string[]): Promise<EditionForRepresentation[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query<{
      id: string;
      title: string;
      description: string | null;
      authors: string[] | null;
      genres: string[] | null;
    }>(
      `SELECT e.id, e.title, e.description,
         (SELECT array_agg(a.name ORDER BY ea.position)
            FROM edition_authors ea JOIN authors a ON a.id = ea.author_id
           WHERE ea.edition_id = e.id) AS authors,
         (SELECT array_agg(g.name ORDER BY eg.votes DESC, g.name)
            FROM edition_genres eg JOIN genres g ON g.id = eg.genre_id
           WHERE eg.edition_id = e.id) AS genres
       FROM editions e WHERE e.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => !!row)
      .map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        authors: row.authors ?? [],
        genres: row.genres ?? [],
      }));
  }

  async candidateReviews(
    editionId: string,
    options: { limit: number; minChars: number },
  ): Promise<CandidateReview[]> {
    const result = await this.pool.query<{
      id: string;
      source_key: string;
      rating: number | null;
      text: string;
    }>(
      `SELECT r.id, s.key AS source_key, r.rating, r.text
       FROM reviews r JOIN review_sources s ON s.id = r.source_id
       WHERE r.edition_id = $1 AND r.text IS NOT NULL AND r.text_length >= $2
         AND s.storage_allowed AND s.enabled
       ORDER BY r.id
       LIMIT $3`,
      [editionId, options.minChars, options.limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceKey: row.source_key,
      rating: row.rating,
      text: row.text,
    }));
  }

  /** Editions in order of Goodreads popularity (rating count), most popular first. */
  async popularEditionIds(limit: number, excludeEmbeddingModel?: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT e.id FROM editions e
       LEFT JOIN review_fetches f
         ON f.edition_id = e.id AND f.reviews_version = 1
        AND f.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
       ${
         excludeEmbeddingModel
           ? `WHERE NOT EXISTS (SELECT 1 FROM book_embeddings b
                WHERE b.edition_id = e.id AND b.embedding_model = $2)`
           : ''
       }
       ORDER BY f.rating_count DESC NULLS LAST, e.id
       LIMIT $1`,
      excludeEmbeddingModel ? [limit, excludeEmbeddingModel] : [limit],
    );
    return result.rows.map((row) => row.id);
  }
}
