import type { Pool } from 'pg';
import { type GeminiClient, LlmError } from '../llm/gemini.client';
import { EMBEDDING_TEXT_VERSION, buildEmbeddingText } from './book-text';
import type { EditionEvidenceRepository } from './edition-evidence.repository';
import { type SelectionOptions, selectEvidence } from './evidence-selection';

/** Fixed by the vector(768) columns in the database (BE-12 migration). */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * The stored model key names everything that shapes a vector, so vectors
 * made differently are never mixed (MODEL-1): model, size and text recipe.
 */
export function embeddingModelKey(model: string): string {
  return `${model}:${EMBEDDING_DIMENSIONS}:${EMBEDDING_TEXT_VERSION}`;
}

export interface EmbedderOptions {
  model: string;
  batchSize: number;
  maxReviews: number;
  maxChars: number;
  candidateLimit: number;
  selection: SelectionOptions;
  log?: (message: string) => void;
}

export interface EmbedReport {
  modelKey: string;
  embedded: number;
  characters: number;
  batches: number;
  /** Set when the run stopped early; already stored vectors are kept. */
  stoppedBecause: string | null;
  durationMs: number;
}

/**
 * Scales a vector to length 1. Some models do not normalise shortened
 * vectors, and the TypeScript scorer compares by dot product (D-006).
 */
export function normalize(values: number[]): number[] {
  const length = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (length === 0) throw new Error('Cannot normalise a zero vector');
  return values.map((v) => v / length);
}

/** Turns a vector into pgvector's text form: [0.1,0.2,...]. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

/**
 * Embeds editions that have no vector yet for the current model key and
 * stores them in book_embeddings. Safe to stop and re-run.
 */
export class BookEmbedder {
  readonly modelKey: string;

  constructor(
    private readonly pool: Pool,
    private readonly repository: EditionEvidenceRepository,
    private readonly client: Pick<GeminiClient, 'embed'>,
    private readonly options: EmbedderOptions,
  ) {
    this.modelKey = embeddingModelKey(options.model);
  }

  async embedMissing(limit: number): Promise<EmbedReport> {
    const started = Date.now();
    const report: EmbedReport = {
      modelKey: this.modelKey,
      embedded: 0,
      characters: 0,
      batches: 0,
      stoppedBecause: null,
      durationMs: 0,
    };
    const ids = await this.repository.popularEditionIds(limit, this.modelKey);
    const log = this.options.log ?? (() => undefined);

    for (let i = 0; i < ids.length; i += this.options.batchSize) {
      const batchIds = ids.slice(i, i + this.options.batchSize);
      const editions = await this.repository.editions(batchIds);
      const texts: string[] = [];
      for (const edition of editions) {
        const candidates = await this.repository.candidateReviews(edition.id, {
          limit: this.options.candidateLimit,
          minChars: this.options.selection.minChars,
        });
        const { selected } = selectEvidence(candidates, {
          ...this.options.selection,
          maxReviews: this.options.maxReviews,
        });
        texts.push(
          buildEmbeddingText(edition, selected, {
            maxReviews: this.options.maxReviews,
            maxChars: this.options.maxChars,
          }),
        );
      }

      let vectors: number[][];
      try {
        ({ vectors } = await this.client.embed(this.options.model, texts, {
          taskType: 'SEMANTIC_SIMILARITY',
          dimensions: EMBEDDING_DIMENSIONS,
        }));
      } catch (error) {
        if (error instanceof LlmError) {
          report.stoppedBecause = `${error.kind}: ${error.message}`;
          break;
        }
        throw error;
      }

      for (let j = 0; j < editions.length; j++) {
        await this.pool.query(
          `INSERT INTO book_embeddings (edition_id, embedding_model, embedding, created_at)
           VALUES ($1, $2, $3::vector, now()) ON CONFLICT DO NOTHING`,
          [editions[j]!.id, this.modelKey, toVectorLiteral(normalize(vectors[j]!))],
        );
      }
      report.embedded += editions.length;
      report.characters += texts.reduce((sum, t) => sum + t.length, 0);
      report.batches++;
      log(`Embedded ${report.embedded.toLocaleString('en')} of ${ids.length.toLocaleString('en')}`);
    }
    report.durationMs = Date.now() - started;
    return report;
  }
}
