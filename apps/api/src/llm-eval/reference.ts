import type { GeminiClient, LlmUsage } from '../llm/gemini.client';
import {
  MAX_THEMES,
  TRAIT_VOCABULARY,
  type TraitInput,
  buildTraitPrompt,
  neutraliseTags,
} from '../representation/traits';

/**
 * The reference labeller of the LLM evaluation (BE-15, D-028): a stronger
 * model than the ones measured, following the committed labelling
 * instructions (eval/llm/*-instructions.md) as a person would. Its labels are
 * the reference the trait extraction and the summaries are measured against.
 */

type Client = Pick<GeminiClient, 'generateJson'>;

export interface TraitLabels {
  pace: string;
  tone: string;
  contentIntensity: string;
  themes: string[];
}

const valueSchema = (values: readonly string[]) => ({
  type: 'string',
  enum: [...values, 'unknown'],
});

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    pace: valueSchema(TRAIT_VOCABULARY.pace),
    tone: valueSchema(TRAIT_VOCABULARY.tone),
    contentIntensity: valueSchema(TRAIT_VOCABULARY.contentIntensity),
    themes: {
      type: 'array',
      maxItems: MAX_THEMES,
      items: { type: 'string', enum: [...TRAIT_VOCABULARY.themes] },
    },
  },
  required: ['pace', 'tone', 'contentIntensity', 'themes'],
};

export class ReferenceError extends Error {
  constructor(
    message: string,
    readonly usage: LlmUsage[],
  ) {
    super(message);
    this.name = 'ReferenceError';
  }
}

/** Checks a label reply against the vocabularies; problems, or the labels. */
export function validateLabels(text: string): { labels: TraitLabels } | { problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problems: ['not JSON'] };
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const one = (key: 'pace' | 'tone' | 'contentIntensity') => {
    const v = r[key];
    const allowed: readonly string[] = [...TRAIT_VOCABULARY[key], 'unknown'];
    if (typeof v !== 'string' || !allowed.includes(v)) problems.push(`${key}: ${String(v)}`);
    return String(v);
  };
  const labels = {
    pace: one('pace'),
    tone: one('tone'),
    contentIntensity: one('contentIntensity'),
    themes: [] as string[],
  };
  if (!Array.isArray(r.themes)) problems.push('themes: expected a list');
  else {
    for (const t of r.themes) {
      if (typeof t !== 'string' || !(TRAIT_VOCABULARY.themes as readonly string[]).includes(t))
        problems.push(`themes: ${String(t)}`);
      else if (!labels.themes.includes(t)) labels.themes.push(t);
    }
    if (labels.themes.length > MAX_THEMES) problems.push(`themes: more than ${MAX_THEMES}`);
  }
  return problems.length > 0 ? { problems } : { labels };
}

/** Labels one book from the same evidence the measured models get. Invalid output is retried once. */
export async function labelTraits(
  client: Client,
  model: string,
  instructions: string,
  input: TraitInput,
): Promise<{ labels: TraitLabels; usage: LlmUsage[] }> {
  const user = buildTraitPrompt(input);
  const usage: LlmUsage[] = [];
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await client.generateJson(model, {
      system: instructions,
      user,
      schema: LABEL_SCHEMA,
      temperature: 0,
    });
    usage.push(reply.usage);
    const result = validateLabels(reply.text);
    if ('labels' in result) return { labels: result.labels, usage };
    problems = result.problems;
  }
  throw new ReferenceError(`Labels were invalid twice: ${problems.slice(0, 3).join('; ')}`, usage);
}

export type ClaimLabel = 'supported' | 'not_supported';

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['supported', 'not_supported'] },
    reason: { type: 'string' },
  },
  required: ['label', 'reason'],
};

export function buildClaimPrompt(claim: {
  kind: 'praise' | 'complaint';
  text: string;
  reviews: string[];
}): string {
  return [
    `Claim (${claim.kind}): ${neutraliseTags(claim.text)}`,
    '',
    ...claim.reviews.map(
      (text, i) => `<review number="${i + 1}">\n${neutraliseTags(text)}\n</review>`,
    ),
  ].join('\n');
}

/** Judges whether the cited reviews support a claim (spec 9 summary faithfulness). */
export async function judgeClaim(
  client: Client,
  model: string,
  instructions: string,
  claim: { kind: 'praise' | 'complaint'; text: string; reviews: string[] },
): Promise<{ label: ClaimLabel; reason: string; usage: LlmUsage[] }> {
  const usage: LlmUsage[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await client.generateJson(model, {
      system: instructions,
      user: buildClaimPrompt(claim),
      schema: JUDGE_SCHEMA,
      temperature: 0,
    });
    usage.push(reply.usage);
    try {
      const r = JSON.parse(reply.text) as { label?: unknown; reason?: unknown };
      if ((r.label === 'supported' || r.label === 'not_supported') && typeof r.reason === 'string')
        return { label: r.label, reason: r.reason.trim(), usage };
    } catch {
      // retried below
    }
  }
  throw new ReferenceError('The judgement was invalid twice', usage);
}
