import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUMMARY_PROMPT_VERSION } from '../analysis/public-summary';
import { loadConfig } from '../config/app-config';
import { findRepoRoot } from '../repo-root';
import { TRAIT_PROMPT_VERSION } from '../representation/traits';

/**
 * EVAL-4 (BE-15, D-028): the committed LLM evaluation outputs must come from
 * the prompts and models the app uses now. Changing a prompt version or a
 * default model fails this test until the evaluation is run again
 * (`llm-eval all`, then `pnpm eval llm`), so every prompt or model change is
 * measured before it ships.
 */
const manifestFile = join(findRepoRoot(), 'eval', 'llm', 'manifest.json');

describe('LLM evaluation outputs are current (EVAL-4)', () => {
  const run = existsSync(manifestFile) ? it : it.skip;

  run('were made with the current prompts and default models', () => {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      traitPromptVersion: string;
      summaryPromptVersion: string;
      models: Record<string, string>;
    };
    const defaults = loadConfig({});
    const now = {
      traitPromptVersion: TRAIT_PROMPT_VERSION,
      summaryPromptVersion: SUMMARY_PROMPT_VERSION,
      models: {
        small: defaults.GEMINI_TRAIT_MODEL,
        large: defaults.GEMINI_TRAIT_MODEL_LARGE,
        summary: defaults.GEMINI_SUMMARY_MODEL,
        reference: defaults.GEMINI_REFERENCE_MODEL,
      },
    };
    const committed = {
      traitPromptVersion: manifest.traitPromptVersion,
      summaryPromptVersion: manifest.summaryPromptVersion,
      models: manifest.models,
    };
    if (JSON.stringify(committed) !== JSON.stringify(now)) {
      throw new Error(
        `eval/llm/ was made with ${JSON.stringify(committed)}, but the app now uses ${JSON.stringify(now)}. ` +
          'Run `pnpm --filter @bookie/api llm-eval all` and `pnpm eval llm --accept` (or keep the baseline to check for a drop).',
      );
    }
  });
});
