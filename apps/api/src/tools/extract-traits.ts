/**
 * Extracts traits for the most popular editions and caches one file per book
 * for the offline evaluation (BE-14: B1 and the traits-only ablation).
 *
 *   pnpm --filter @bookie/api traits:extract --limit 1000
 *   pnpm --filter @bookie/api traits:extract --limit 1000 --retry-failed
 *
 * Output: data/derived/traits/<model>/<prompt version>/<edition id>.json
 * (git-ignored). Books with a file are skipped, so the command can be stopped
 * and re-run; a book whose output was invalid twice is recorded as failed and
 * tried again only with --retry-failed. The files hold trait values, the
 * evidence numbers cited and the review IDs they point to, never review text
 * (D-004). The live pipeline extracts the same traits with the same prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { LlmError } from '../llm/gemini.client';
import { EditionEvidenceRepository } from '../representation/edition-evidence.repository';
import { selectEvidence } from '../representation/evidence-selection';
import { geminiClient, selectionOptions } from '../representation/representation-config';
import {
  TRAIT_PROMPT_VERSION,
  TraitExtractionError,
  extractTraits,
} from '../representation/traits';
import { runCli, startCli, timestamp, wholeNumber } from './cli';

runCli(async () => {
  const { root, config, values } = startCli({
    limit: { type: 'string' },
    model: { type: 'string', default: 'small' },
    'retry-failed': { type: 'boolean', default: false },
  });
  const limit = wholeNumber(values.limit, '--limit', 100);
  if (values.model !== 'small' && values.model !== 'large')
    throw new Error('--model must be small or large');
  const model =
    values.model === 'large' ? config.GEMINI_TRAIT_MODEL_LARGE : config.GEMINI_TRAIT_MODEL;
  const dir = join(root, 'data', 'derived', 'traits', model, TRAIT_PROMPT_VERSION);
  mkdirSync(dir, { recursive: true });

  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const repository = new EditionEvidenceRepository(pool);
  const client = geminiClient(config);
  const selection = selectionOptions(config, config.EVIDENCE_MAX_REVIEWS);
  const counts = { cached: 0, extracted: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  let stoppedBecause: string | null = null;

  try {
    const ids = await repository.popularEditionIds(limit);
    const todo = ids.filter((id) => {
      const file = join(dir, `${id}.json`);
      if (!existsSync(file)) return true;
      const failed = 'error' in (JSON.parse(readFileSync(file, 'utf8')) as object);
      if (failed && values['retry-failed']) return true;
      counts.cached += 1;
      return false;
    });
    console.log(
      `${timestamp()} ${ids.length} books, ${counts.cached} cached, ${todo.length} to do`,
    );

    for (const edition of await repository.editions(todo)) {
      const candidates = await repository.candidateReviews(edition.id, {
        limit: config.EVIDENCE_CANDIDATE_LIMIT,
        minChars: config.EVIDENCE_MIN_REVIEW_CHARS,
      });
      const { selected } = selectEvidence(candidates, selection);
      const base = {
        editionId: edition.id,
        model,
        promptVersion: TRAIT_PROMPT_VERSION,
        reviewsSelected: selected.length,
        // Evidence number -> review ID, so citations can be checked without storing text.
        citedReviewIds: Object.fromEntries(selected.map((r) => [r.position, r.id])),
        extractedAt: new Date().toISOString(),
      };
      const file = join(dir, `${edition.id}.json`);
      try {
        const result = await extractTraits(client, model, {
          title: edition.title,
          authors: edition.authors,
          description: edition.description,
          reviews: selected,
        });
        for (const u of result.usage) {
          counts.inputTokens += u.inputTokens;
          counts.outputTokens += u.outputTokens;
        }
        writeFileSync(
          file,
          JSON.stringify({ ...base, traits: result.traits, attempts: result.attempts }, null, 2),
        );
        counts.extracted += 1;
        console.log(
          `${timestamp()} [${counts.extracted + counts.failed}/${todo.length}] ${edition.title}: ` +
            `pace ${result.traits.pace.value}, tone ${result.traits.tone.value}, ` +
            `intensity ${result.traits.contentIntensity.value}, ` +
            `themes ${result.traits.themes.map((t) => t.value).join(', ') || 'none'}`,
        );
      } catch (error) {
        if (error instanceof TraitExtractionError) {
          counts.failed += 1;
          writeFileSync(
            file,
            JSON.stringify({ ...base, error: { kind: error.code, problems: error.problems } }),
          );
          console.log(`${timestamp()} ${edition.title}: invalid output twice, recorded as failed`);
          continue;
        }
        // Service trouble is not the book's fault: write nothing so a re-run tries it again.
        const kind = error instanceof LlmError ? error.kind : 'error';
        console.log(`${timestamp()} ${edition.title}: ${kind}: ${(error as Error).message}`);
        if (kind === 'quota' || kind === 'auth') {
          stoppedBecause = kind;
          break;
        }
      }
    }
  } finally {
    await pool.end();
  }
  console.log(JSON.stringify({ model, dir, ...counts, stoppedBecause }, null, 2));
  if (stoppedBecause) process.exitCode = 2;
});
