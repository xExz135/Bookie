import type { AppConfig } from '../config/app-config';
import { GeminiClient } from '../llm/gemini.client';
import { GroqClient } from '../llm/groq.client';
import type { VisionProvider, VisionReader } from './cover-reader';

type VisionConfig = Pick<
  AppConfig,
  | 'SCAN_VISION_PROVIDER'
  | 'SCAN_VISION_FALLBACK'
  | 'SCAN_TIMEOUT_MS'
  | 'GROQ_API_KEY'
  | 'GROQ_VISION_MODEL'
  | 'GROQ_MAX_REQUESTS_PER_MINUTE'
  | 'GEMINI_API_KEY'
  | 'GEMINI_VISION_MODEL'
  | 'GEMINI_MAX_REQUESTS_PER_MINUTE'
  | 'GEMINI_TOKENS_PER_MINUTE'
>;

/**
 * The providers that read cover photos, in the order to try them (D-030):
 * the chosen provider first, then the other one when fallback is on.
 * A provider without a key is left out; if none has a key, the chosen one
 * stays, so a scan reports the missing key as before.
 */
export function visionOrder(config: VisionConfig): VisionProvider[] {
  const first = config.SCAN_VISION_PROVIDER;
  const other: VisionProvider = first === 'groq' ? 'gemini' : 'groq';
  const wanted = config.SCAN_VISION_FALLBACK ? [first, other] : [first];
  const hasKey = { groq: Boolean(config.GROQ_API_KEY), gemini: Boolean(config.GEMINI_API_KEY) };
  const usable = wanted.filter((provider) => hasKey[provider]);
  return usable.length > 0 ? usable : [first];
}

/** Builds the readers. Each has its own client, so a scan fails fast rather than waiting a minute. */
export function buildVisionReaders(config: VisionConfig): VisionReader[] {
  return visionOrder(config).map((provider) =>
    provider === 'groq'
      ? {
          provider,
          model: config.GROQ_VISION_MODEL,
          client: new GroqClient({
            apiKey: config.GROQ_API_KEY,
            timeoutMs: config.SCAN_TIMEOUT_MS,
            maxRequestsPerMinute: config.GROQ_MAX_REQUESTS_PER_MINUTE,
            transientRetries: 1,
          }),
        }
      : {
          provider,
          model: config.GEMINI_VISION_MODEL,
          client: new GeminiClient({
            apiKey: config.GEMINI_API_KEY,
            timeoutMs: config.SCAN_TIMEOUT_MS,
            maxRequestsPerMinute: config.GEMINI_MAX_REQUESTS_PER_MINUTE,
            tokensPerMinute: config.GEMINI_TOKENS_PER_MINUTE,
            transientRetries: 1,
          }),
        },
  );
}
