/**
 * The LLM evaluation (BE-15, spec 9, D-028): trait extraction and summary
 * faithfulness, measured against reference labels from a stronger model.
 *
 *   pnpm --filter @bookie/api llm-eval select       # choose the evaluation set (eval/llm/set.json)
 *   pnpm --filter @bookie/api llm-eval select traits  # ... from books with batch traits (D-028 update)
 *   pnpm --filter @bookie/api llm-eval traits small # the measured models on the set (the small
 *                                                   # model reuses traits:extract answers for the same evidence)
 *   pnpm --filter @bookie/api llm-eval traits large
 *   pnpm --filter @bookie/api llm-eval reference    # the reference labels
 *   pnpm --filter @bookie/api llm-eval summaries    # golden summaries for part of the set
 *   pnpm --filter @bookie/api llm-eval claims       # judge a sample of their claims
 *   pnpm --filter @bookie/api llm-eval export       # write the committed files in eval/llm/
 *   pnpm --filter @bookie/api llm-eval sheet        # evidence for the hand-labelling workbook (local only)
 *   pnpm --filter @bookie/api llm-eval all          # every step in order (re-runnable)
 *
 * Every model answer is cached per book in data/derived/llm-eval/, so a run
 * that stops at a quota continues where it stopped. All models see exactly
 * the same evidence, chosen as the pipeline chooses it. The committed files
 * hold IDs, labels and model output only, never review text (D-004, EVAL-3).
 * Then `pnpm eval llm` computes the metrics.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import type { AppConfig } from '../config/app-config';
import { SUMMARY_PROMPT_VERSION, SummaryError, generateSummary } from '../analysis/public-summary';
import { LlmError, type LlmUsage } from '../llm/gemini.client';
import {
  type BatchTraitFile,
  chooseFromBatch,
  sameEvidence,
  seededOrder,
} from '../llm-eval/eval-set';
import { ReferenceError, judgeClaim, labelTraits } from '../llm-eval/reference';
import { EditionEvidenceRepository } from '../representation/edition-evidence.repository';
import { selectEvidence } from '../representation/evidence-selection';
import { geminiClient, selectionOptions } from '../representation/representation-config';
import {
  TRAIT_PROMPT_VERSION,
  TraitExtractionError,
  extractTraits,
} from '../representation/traits';
import { runCli, startCli, timestamp } from './cli';

const STEPS = [
  'select',
  'traits',
  'reference',
  'summaries',
  'claims',
  'export',
  'sheet',
  'all',
] as const;
type Step = (typeof STEPS)[number];

interface EvalSet {
  seed: number;
  /** Where the books come from: the most-rated catalog, or the books with batch traits. */
  source?: 'catalog' | 'traits:extract';
  /** How many books the sample was drawn from. */
  catalog: number;
  minReviews: number;
  books: Array<{ editionId: string; goodreadsBookId: string | null; title: string }>;
  summaryBooks: string[];
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const tokens = (usage: LlmUsage[]) => ({
  inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
  outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
});

class QuotaStop extends Error {}

class EvalContext {
  readonly pool: Pool;
  readonly repository: EditionEvidenceRepository;
  readonly client;
  readonly evalDir: string;
  readonly cacheDir: string;
  readonly setFile: string;

  constructor(
    readonly root: string,
    readonly config: AppConfig,
  ) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL });
    this.repository = new EditionEvidenceRepository(this.pool);
    // Free tier: 20 requests a day for the larger models, and refused attempts count, so
    // the evaluation does not retry; a book that failed is tried again on the next run.
    this.client = geminiClient({ ...config, GEMINI_TRANSIENT_RETRIES: 0 });
    this.evalDir = join(root, 'eval', 'llm');
    this.cacheDir = join(root, 'data', 'derived', 'llm-eval');
    this.setFile = join(this.evalDir, 'set.json');
  }

  close() {
    return this.pool.end();
  }

  private set(): EvalSet {
    if (!existsSync(this.setFile))
      throw new Error('No eval/llm/set.json yet. Run `llm-eval select`.');
    return JSON.parse(readFileSync(this.setFile, 'utf8')) as EvalSet;
  }

  private read<T>(file: string): T | null {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
  }

  private write(file: string, data: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** The evidence the pipeline would give the model for this book. */
  private async evidence(editionId: string) {
    const [edition] = await this.repository.editions([editionId]);
    if (!edition) throw new Error(`Edition ${editionId} is missing`);
    const candidates = await this.repository.candidateReviews(editionId, {
      limit: this.config.EVIDENCE_CANDIDATE_LIMIT,
      minChars: this.config.EVIDENCE_MIN_REVIEW_CHARS,
    });
    const { selected } = selectEvidence(
      candidates,
      selectionOptions(this.config, this.config.EVIDENCE_MAX_REVIEWS),
    );
    return {
      input: {
        title: edition.title,
        authors: edition.authors,
        description: edition.description,
        reviews: selected,
      },
      selected,
    };
  }

  /** Busy or timed-out answers in a row; three end the step for today. */
  private busy = 0;

  /**
   * Service trouble is not the book's fault: stop on quota, auth or an
   * unusable model, and after three busy answers in a row (more attempts would
   * only use up the day's requests); skip the book otherwise.
   */
  private serviceError(error: unknown, title: string): void {
    const kind = error instanceof LlmError ? error.kind : 'error';
    this.busy = kind === 'unavailable' || kind === 'timeout' ? this.busy + 1 : 0;
    if (this.busy >= 3) {
      this.busy = 0;
      throw new QuotaStop('Stopped: the model is busy');
    }
    console.log(`${timestamp()} ${title}: ${kind}: ${(error as Error).message.slice(0, 160)}`);
    // A model that is not available to this key fails every book the same way: stop.
    if (kind === 'quota' || kind === 'auth' || kind === 'invalid_request')
      throw new QuotaStop(`Stopped: ${kind}`);
  }

  /** Where `traits:extract` caches the small model's answers (D-023). */
  private batchDir(): string {
    return join(
      this.root,
      'data',
      'derived',
      'traits',
      this.config.GEMINI_TRAIT_MODEL,
      TRAIT_PROMPT_VERSION,
    );
  }

  private batchFile(editionId: string): BatchTraitFile | null {
    return this.read<BatchTraitFile>(join(this.batchDir(), `${editionId}.json`));
  }

  /**
   * A seeded sample of the most-rated editions with enough review text (spec 9),
   * or, with `select traits`, of the books whose traits `traits:extract` already
   * has (D-028 update: the small model's answers cost nothing more).
   */
  async select(from?: string) {
    if (from !== undefined && from !== 'traits') throw new Error('Say `select` or `select traits`');
    if (existsSync(this.setFile)) {
      console.log('eval/llm/set.json exists; delete it to choose a new set.');
      return;
    }
    if (from === 'traits') return this.selectFromTraits();
    const top = await this.repository.popularEditionIds(this.config.LLM_EVAL_CATALOG);
    const eligible = await this.pool.query<{ id: string; title: string; goodreads: string | null }>(
      `SELECT e.id, e.title,
              (SELECT x.external_id FROM edition_external_ids x JOIN review_sources s ON s.id = x.source_id
                WHERE x.edition_id = e.id AND s.key = 'goodreads_dataset') AS goodreads
         FROM editions e
        WHERE e.id = ANY($1::uuid[])
          AND (SELECT count(*) FROM (SELECT 1 FROM reviews r WHERE r.edition_id = e.id AND r.text IS NOT NULL
                                        AND r.text_length >= $2 LIMIT $3) c) >= $3`,
      [top, this.config.EVIDENCE_MIN_REVIEW_CHARS, this.config.EVIDENCE_SUFFICIENT_REVIEWS],
    );
    const chosen = seededOrder(eligible.rows, (r) => r.id, this.config.LLM_EVAL_SEED).slice(
      0,
      this.config.LLM_EVAL_BOOKS,
    );
    const set: EvalSet = {
      seed: this.config.LLM_EVAL_SEED,
      source: 'catalog',
      catalog: this.config.LLM_EVAL_CATALOG,
      minReviews: this.config.EVIDENCE_SUFFICIENT_REVIEWS,
      books: chosen.map((r) => ({ editionId: r.id, goodreadsBookId: r.goodreads, title: r.title })),
      summaryBooks: chosen.slice(0, this.config.LLM_EVAL_SUMMARY_BOOKS).map((r) => r.id),
    };
    this.write(this.setFile, set);
    console.log(
      `${chosen.length} of ${eligible.rows.length} eligible books chosen; ${set.summaryBooks.length} get a golden summary`,
    );
  }

  private async selectFromTraits() {
    const dir = this.batchDir();
    if (!existsSync(dir)) throw new Error(`No batch traits in ${dir}. Run traits:extract first.`);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read<BatchTraitFile>(join(dir, f))!)
      .filter((f) => f.promptVersion === TRAIT_PROMPT_VERSION);
    const ids = chooseFromBatch(files, {
      seed: this.config.LLM_EVAL_SEED,
      books: this.config.LLM_EVAL_BOOKS,
      minReviews: this.config.EVIDENCE_SUFFICIENT_REVIEWS,
    });
    const rows = await this.pool.query<{ id: string; title: string; goodreads: string | null }>(
      `SELECT e.id, e.title,
              (SELECT x.external_id FROM edition_external_ids x JOIN review_sources s ON s.id = x.source_id
                WHERE x.edition_id = e.id AND s.key = 'goodreads_dataset') AS goodreads
         FROM editions e WHERE e.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    const set: EvalSet = {
      seed: this.config.LLM_EVAL_SEED,
      source: 'traits:extract',
      catalog: files.length,
      minReviews: this.config.EVIDENCE_SUFFICIENT_REVIEWS,
      books: ids.map((id) => ({
        editionId: id,
        goodreadsBookId: byId.get(id)?.goodreads ?? null,
        title: byId.get(id)?.title ?? '',
      })),
      summaryBooks: ids.slice(0, this.config.LLM_EVAL_SUMMARY_BOOKS),
    };
    this.write(this.setFile, set);
    const failed = ids.filter((id) => this.batchFile(id)?.error).length;
    console.log(
      `${ids.length} of ${files.length} books with batch traits chosen (${failed} with a failed answer, ` +
        `counted as wrong); ${set.summaryBooks.length} get a golden summary`,
    );
  }

  private modelOf(which: string | undefined): string {
    if (which === 'small') return this.config.GEMINI_TRAIT_MODEL;
    if (which === 'large') return this.config.GEMINI_TRAIT_MODEL_LARGE;
    throw new Error('Say which model: traits small, or traits large');
  }

  /** The measured model's traits for every book of the set, with its token use. */
  async traits(which?: string) {
    const model = this.modelOf(which);
    const dir = join(this.cacheDir, 'traits', model, TRAIT_PROMPT_VERSION);
    const set = this.set();
    let done = 0;
    let reused = 0;
    let changed = 0;
    for (const book of set.books) {
      const file = join(dir, `${book.editionId}.json`);
      if (existsSync(file)) continue;
      const { input, selected } = await this.evidence(book.editionId);
      // The small model's answer from traits:extract, when it read exactly this evidence:
      // same model, prompt and reviews, so asking again would only repeat it (D-028 update).
      const batch =
        model === this.config.GEMINI_TRAIT_MODEL ? this.batchFile(book.editionId) : null;
      if (batch && batch.promptVersion === TRAIT_PROMPT_VERSION) {
        if (sameEvidence(batch.citedReviewIds, selected)) {
          this.write(file, {
            model,
            promptVersion: TRAIT_PROMPT_VERSION,
            ...(batch.error ? { error: 'invalid_output' } : { traits: batch.traits }),
            attempts: batch.attempts ?? null,
            // traits:extract does not record tokens: cost is unknown, not zero.
            reusedFrom: 'traits:extract',
          });
          reused++;
          continue;
        }
        changed++;
      }
      // A set drawn from the batch is measured on the batch answers only: no new requests.
      if (set.source === 'traits:extract' && model === this.config.GEMINI_TRAIT_MODEL) continue;
      try {
        const result = await extractTraits(this.client, model, input);
        this.write(file, {
          model,
          promptVersion: TRAIT_PROMPT_VERSION,
          traits: result.traits,
          attempts: result.attempts,
          ...tokens(result.usage),
        });
        done++;
        this.busy = 0;
      } catch (error) {
        if (error instanceof TraitExtractionError) {
          // Spec 8: invalid twice is a failure, and is measured as one.
          this.write(file, {
            model,
            promptVersion: TRAIT_PROMPT_VERSION,
            error: 'invalid_output',
            ...tokens(error.usage),
          });
          done++;
          continue;
        }
        this.serviceError(error, book.title);
      }
    }
    console.log(
      `${timestamp()} ${model}: ${done} new books, ${reused} reused from traits:extract` +
        (changed ? `, ${changed} not reused because their evidence changed since` : ''),
    );
  }

  private instructions(name: 'traits' | 'claims'): { text: string; sha: string } {
    const text = readFileSync(join(this.evalDir, `${name}-instructions.md`), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    return { text, sha: sha(text) };
  }

  /** The reference labels, from the same evidence, by the stronger model. */
  async reference() {
    const model = this.config.GEMINI_REFERENCE_MODEL;
    const instructions = this.instructions('traits');
    const dir = join(this.cacheDir, 'reference', model, 'traits', instructions.sha.slice(0, 12));
    let done = 0;
    for (const book of this.set().books) {
      const file = join(dir, `${book.editionId}.json`);
      if (existsSync(file)) continue;
      const { input } = await this.evidence(book.editionId);
      try {
        const result = await labelTraits(this.client, model, instructions.text, input);
        this.write(file, { model, labels: result.labels, ...tokens(result.usage) });
        done++;
        this.busy = 0;
      } catch (error) {
        if (error instanceof ReferenceError) {
          this.write(file, { model, error: 'invalid_output' });
          continue;
        }
        this.serviceError(error, book.title);
      }
    }
    console.log(`${timestamp()} reference ${model}: ${done} new books`);
  }

  /** Golden summaries: the pipeline's summary of each summary book, with its citations. */
  async summaries() {
    const model = this.config.GEMINI_SUMMARY_MODEL;
    const dir = join(this.cacheDir, 'summaries', model, SUMMARY_PROMPT_VERSION);
    let done = 0;
    for (const editionId of this.set().summaryBooks) {
      const file = join(dir, `${editionId}.json`);
      if (existsSync(file)) continue;
      const { input, selected } = await this.evidence(editionId);
      const reviewIds = Object.fromEntries(selected.map((r) => [r.position, r.id]));
      try {
        const result = await generateSummary(this.client, model, input);
        this.write(file, {
          model,
          promptVersion: SUMMARY_PROMPT_VERSION,
          summary: result.summary,
          reviewIds,
          attempts: result.attempts,
          ...tokens(result.usage),
        });
        done++;
        this.busy = 0;
      } catch (error) {
        if (error instanceof SummaryError) {
          this.write(file, {
            model,
            promptVersion: SUMMARY_PROMPT_VERSION,
            error: 'invalid_output',
          });
          done++;
          continue;
        }
        this.serviceError(error, input.title);
      }
    }
    console.log(`${timestamp()} summaries ${model}: ${done} new books`);
  }

  /** Every claim of the golden summaries, with a stable key. */
  private allClaims() {
    const model = this.config.GEMINI_SUMMARY_MODEL;
    const dir = join(this.cacheDir, 'summaries', model, SUMMARY_PROMPT_VERSION);
    const claims: Array<{
      key: string;
      editionId: string;
      kind: 'praise' | 'complaint';
      text: string;
      reviewIds: string[];
    }> = [];
    for (const editionId of this.set().summaryBooks) {
      const s = this.read<{
        summary?: {
          praises: Array<{ text: string; evidence: number[] }>;
          complaints: Array<{ text: string; evidence: number[] }>;
        };
        reviewIds: Record<string, string>;
      }>(join(dir, `${editionId}.json`));
      if (!s?.summary) continue;
      for (const kind of ['praise', 'complaint'] as const) {
        const list = kind === 'praise' ? s.summary.praises : s.summary.complaints;
        list.forEach((c, i) => {
          claims.push({
            key: sha(`${editionId}:${kind}:${i}`).slice(0, 16),
            editionId,
            kind,
            text: c.text,
            reviewIds: c.evidence
              .map((n) => s.reviewIds[String(n)])
              .filter((id): id is string => !!id),
          });
        });
      }
    }
    return claims;
  }

  /** Judges a seeded sample of the claims against their cited reviews (spec 9). */
  async claims() {
    const model = this.config.GEMINI_REFERENCE_MODEL;
    const instructions = this.instructions('claims');
    const dir = join(this.cacheDir, 'reference', model, 'claims', instructions.sha.slice(0, 12));
    const sample = seededOrder(this.allClaims(), (c) => c.key, this.config.LLM_EVAL_SEED).slice(
      0,
      this.config.LLM_EVAL_CLAIMS,
    );
    let done = 0;
    for (const claim of sample) {
      const file = join(dir, `${claim.key}.json`);
      if (existsSync(file)) continue;
      const texts = await this.pool.query<{ id: string; text: string }>(
        `SELECT id, text FROM reviews WHERE id = ANY($1::uuid[])`,
        [claim.reviewIds],
      );
      const byId = new Map(texts.rows.map((r) => [r.id, r.text]));
      // The judge reads each cited review cut as the summary model saw it.
      const reviews = claim.reviewIds.map((id) =>
        (byId.get(id) ?? '').slice(0, this.config.EVIDENCE_MAX_REVIEW_CHARS),
      );
      try {
        const result = await judgeClaim(this.client, model, instructions.text, {
          kind: claim.kind,
          text: claim.text,
          reviews,
        });
        this.write(file, { model, label: result.label, reason: result.reason });
        done++;
        this.busy = 0;
      } catch (error) {
        if (error instanceof ReferenceError) {
          this.write(file, { model, error: 'invalid_output' });
          continue;
        }
        this.serviceError(error, `claim ${claim.key}`);
      }
    }
    console.log(
      `${timestamp()} claims judged by ${model}: ${done} new (sample of ${sample.length})`,
    );
  }

  /** The committed files: labels, IDs and model output only, never review text. */
  async export() {
    const set = this.set();
    const traitsInstr = this.instructions('traits');
    const claimsInstr = this.instructions('claims');
    const datasetIds = await this.datasetReviewIds();

    const traitFiles = (model: string) => {
      const dir = join(this.cacheDir, 'traits', model, TRAIT_PROMPT_VERSION);
      const books: Record<string, unknown> = {};
      for (const b of set.books) {
        const r = this.read<
          Record<string, unknown> & {
            traits?: Record<string, { value: string } | Array<{ value: string }>>;
          }
        >(join(dir, `${b.editionId}.json`));
        if (!r) continue;
        books[b.editionId] = r.traits
          ? {
              pace: (r.traits.pace as { value: string }).value,
              tone: (r.traits.tone as { value: string }).value,
              contentIntensity: (r.traits.contentIntensity as { value: string }).value,
              themes: (r.traits.themes as Array<{ value: string }>).map((t) => t.value),
              attempts: r.attempts,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
            }
          : // Answers reused from traits:extract have no token record: left out, not zero.
            { error: r.error, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
      }
      return { model, promptVersion: TRAIT_PROMPT_VERSION, books };
    };
    for (const model of [this.config.GEMINI_TRAIT_MODEL, this.config.GEMINI_TRAIT_MODEL_LARGE]) {
      this.write(join(this.evalDir, 'traits', `${model}.json`), traitFiles(model));
    }

    const refModel = this.config.GEMINI_REFERENCE_MODEL;
    const refDir = join(
      this.cacheDir,
      'reference',
      refModel,
      'traits',
      traitsInstr.sha.slice(0, 12),
    );
    const labels: Record<string, unknown> = {};
    for (const b of set.books) {
      const r = this.read<{ labels?: unknown; error?: string }>(
        join(refDir, `${b.editionId}.json`),
      );
      if (r) labels[b.editionId] = r.labels ?? { error: r.error };
    }
    this.write(join(this.evalDir, 'reference-traits.json'), {
      model: refModel,
      instructionsSha256: traitsInstr.sha,
      books: labels,
    });

    const claimDir = join(
      this.cacheDir,
      'reference',
      refModel,
      'claims',
      claimsInstr.sha.slice(0, 12),
    );
    const sample = seededOrder(this.allClaims(), (c) => c.key, this.config.LLM_EVAL_SEED).slice(
      0,
      this.config.LLM_EVAL_CLAIMS,
    );
    const claims = sample.flatMap((c) => {
      const j = this.read<{ label?: string; reason?: string; error?: string }>(
        join(claimDir, `${c.key}.json`),
      );
      if (!j) return [];
      return [
        {
          key: c.key,
          editionId: c.editionId,
          kind: c.kind,
          // Model-written claim text, not review text.
          text: c.text,
          citedDatasetReviewIds: c.reviewIds.map((id) => datasetIds.get(id) ?? null),
          label: j.label ?? null,
          reason: j.reason ?? null,
          error: j.error ?? null,
        },
      ];
    });
    const summaryModel = this.config.GEMINI_SUMMARY_MODEL;
    const sumDir = join(this.cacheDir, 'summaries', summaryModel, SUMMARY_PROMPT_VERSION);
    const summaryRuns = set.summaryBooks.flatMap((id) => {
      const s = this.read<{
        summary?: { praises: unknown[]; complaints: unknown[] };
        error?: string;
        attempts?: number;
        inputTokens?: number;
        outputTokens?: number;
      }>(join(sumDir, `${id}.json`));
      return s
        ? [
            {
              editionId: id,
              error: s.error ?? null,
              attempts: s.attempts ?? null,
              claims: s.summary ? s.summary.praises.length + s.summary.complaints.length : 0,
              inputTokens: s.inputTokens ?? 0,
              outputTokens: s.outputTokens ?? 0,
            },
          ]
        : [];
    });
    this.write(join(this.evalDir, 'claims.json'), {
      summaryModel,
      summaryPromptVersion: SUMMARY_PROMPT_VERSION,
      judgeModel: refModel,
      instructionsSha256: claimsInstr.sha,
      seed: this.config.LLM_EVAL_SEED,
      summaries: summaryRuns,
      claims,
    });
    this.write(join(this.evalDir, 'manifest.json'), {
      traitPromptVersion: TRAIT_PROMPT_VERSION,
      summaryPromptVersion: SUMMARY_PROMPT_VERSION,
      models: {
        small: this.config.GEMINI_TRAIT_MODEL,
        large: this.config.GEMINI_TRAIT_MODEL_LARGE,
        summary: summaryModel,
        reference: refModel,
      },
      evidence: {
        maxReviews: this.config.EVIDENCE_MAX_REVIEWS,
        candidateLimit: this.config.EVIDENCE_CANDIDATE_LIMIT,
        minReviewChars: this.config.EVIDENCE_MIN_REVIEW_CHARS,
        maxReviewChars: this.config.EVIDENCE_MAX_REVIEW_CHARS,
      },
    });
    const count = (dir: string) => (existsSync(dir) ? readdirSync(dir).length : 0);
    console.log(
      `Exported: ${set.books.length} books; reference labels ${Object.keys(labels).length}; ` +
        `claims judged ${claims.length} (${count(sumDir)} summaries)`,
    );
  }

  /**
   * The evidence of every set book, for the hand-labelling workbook (D-028):
   * the same description and reviews the models see. Written to
   * data/derived/ only, because it holds review text (D-004).
   */
  async sheet() {
    const books = [];
    for (const [i, book] of this.set().books.entries()) {
      const { input } = await this.evidence(book.editionId);
      books.push({
        number: i + 1,
        editionId: book.editionId,
        goodreadsBookId: book.goodreadsBookId,
        title: input.title,
        authors: input.authors,
        description: input.description,
        reviews: input.reviews.map((r) => ({
          number: r.position,
          rating: r.rating,
          text: r.text,
        })),
      });
    }
    const file = join(this.cacheDir, 'labelling', 'books.json');
    this.write(file, { set: this.setFile, books });
    console.log(`${timestamp()} evidence for ${books.length} books written to ${file}`);
  }

  /** Dataset review IDs for internal review IDs (EVAL-3: committed sets hold dataset IDs). */
  private async datasetReviewIds(): Promise<Map<string, string>> {
    const ids = this.allClaims().flatMap((c) => c.reviewIds);
    if (ids.length === 0) return new Map();
    const rows = await this.pool.query<{ id: string; external_review_id: string }>(
      `SELECT id, external_review_id FROM reviews WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.rows.map((r) => [r.id, r.external_review_id]));
  }
}

runCli(async () => {
  const { root, config, positionals } = startCli({}, { positionals: true });
  const step = positionals[0] as Step | undefined;
  if (!step || !STEPS.includes(step)) throw new Error(`Give a step: ${STEPS.join(', ')}`);
  const ctx = new EvalContext(root, config);
  try {
    const run = async (s: Exclude<Step, 'all'>, arg?: string) => {
      console.log(`${timestamp()} ${s}${arg ? ` ${arg}` : ''}`);
      await ctx[s](arg ?? positionals[1]);
    };
    if (step === 'all') {
      // Each model has its own quota: a step that stops at one does not stop the others.
      let stopped = 0;
      const attempt = async (s: Exclude<Step, 'all'>, arg?: string) => {
        try {
          await run(s, arg);
        } catch (error) {
          if (!(error instanceof QuotaStop)) throw error;
          console.log(`${timestamp()} ${s}${arg ? ` ${arg}` : ''}: ${error.message}`);
          stopped++;
        }
      };
      if (!existsSync(ctx.setFile)) await run('select');
      await attempt('traits', 'small');
      await attempt('traits', 'large');
      // Claims before the reference traits: since D-028's change the owner's hand labels are
      // the trait reference, and the model's trait labels only measure agreement with them.
      await attempt('summaries');
      await attempt('claims');
      await attempt('reference');
      await run('export');
      if (stopped > 0) throw new QuotaStop(`${stopped} step(s) stopped early`);
    } else {
      await run(step);
    }
  } catch (error) {
    if (error instanceof QuotaStop) {
      console.log(`${timestamp()} ${error.message}. Run again after the quota resets.`);
      process.exitCode = 2;
    } else throw error;
  } finally {
    await ctx.close();
  }
});
