/**
 * Extracts traits for the most popular editions and saves the results for
 * review and for the H2 model comparison (BE-12, BE-15).
 *
 *   pnpm --filter @bookie/api traits:sample --limit 20                 # smaller model
 *   pnpm --filter @bookie/api traits:sample --limit 20 --model large   # larger model
 *
 * Output: data/derived/traits-<model>-<time>.json (git-ignored: it names
 * dataset review IDs). Review text is never written to the file (D-004).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { LlmError } from '../llm/gemini.client';
import { EditionEvidenceRepository } from '../representation/edition-evidence.repository';
import { selectEvidence } from '../representation/evidence-selection';
import { geminiClient, selectionOptions } from '../representation/representation-config';
import { TraitExtractionError, extractTraits } from '../representation/traits';
import { runCli, startCli, timestamp, wholeNumber } from './cli';

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

runCli(async () => {
  const { root, config, values } = startCli({
    limit: { type: 'string' },
    model: { type: 'string', default: 'small' },
  });
  const limit = wholeNumber(values.limit, '--limit', 10);
  if (values.model !== 'small' && values.model !== 'large')
    throw new Error('--model must be small or large');
  const model =
    values.model === 'large' ? config.GEMINI_TRAIT_MODEL_LARGE : config.GEMINI_TRAIT_MODEL;

  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const repository = new EditionEvidenceRepository(pool);
  const client = geminiClient(config);
  const selection = selectionOptions(config, config.EVIDENCE_MAX_REVIEWS);
  const results: object[] = [];
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let waitedMs = 0;
  const failures: Record<string, number> = {};

  try {
    const ids = await repository.popularEditionIds(limit);
    for (const edition of await repository.editions(ids)) {
      const candidates = await repository.candidateReviews(edition.id, {
        limit: config.EVIDENCE_CANDIDATE_LIMIT,
        minChars: config.EVIDENCE_MIN_REVIEW_CHARS,
      });
      const { selected, dropped } = selectEvidence(candidates, selection);
      const base = {
        editionId: edition.id,
        title: edition.title,
        evidence: { selected: selected.length, dropped },
        // Position -> review ID, so citations can be checked later without storing text.
        citedReviewIds: Object.fromEntries(selected.map((r) => [r.position, r.id])),
      };
      try {
        const result = await extractTraits(client, model, {
          title: edition.title,
          authors: edition.authors,
          description: edition.description,
          reviews: selected,
        });
        for (const u of result.usage) {
          inputTokens += u.inputTokens;
          outputTokens += u.outputTokens;
          waitedMs += u.waitedMs;
        }
        latencies.push(result.usage.reduce((sum, u) => sum + u.latencyMs, 0));
        results.push({
          ...base,
          traits: result.traits,
          attempts: result.attempts,
          usage: result.usage,
        });
        console.log(
          `${timestamp()} ${edition.title}: pace ${result.traits.pace.value}, tone ${result.traits.tone.value}, ` +
            `intensity ${result.traits.contentIntensity.value}, themes ${result.traits.themes.map((t) => t.value).join(', ') || 'none'}`,
        );
      } catch (error) {
        const kind =
          error instanceof TraitExtractionError
            ? error.code
            : error instanceof LlmError
              ? error.kind
              : 'error';
        failures[kind] = (failures[kind] ?? 0) + 1;
        results.push({ ...base, error: { kind, message: (error as Error).message } });
        console.log(
          `${timestamp()} ${edition.title}: FAILED (${kind}) ${(error as Error).message}`,
        );
        if (error instanceof LlmError && (error.kind === 'quota' || error.kind === 'auth')) break;
      }
    }
  } finally {
    await pool.end();
  }

  const summary = {
    model,
    books: results.length,
    succeeded: results.length - Object.values(failures).reduce((a, b) => a + b, 0),
    failures,
    tokens: { input: inputTokens, output: outputTokens },
    // Model time only. Our own rate-limit waiting is reported separately.
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    waitedMs,
  };
  const dir = join(root, 'data', 'derived');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `traits-${model}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved ${file}`);
});
