import { detect } from 'tinyld';
import type { AppConfig } from '../config/app-config';
import { GeminiClient } from '../llm/gemini.client';
import type { SelectionOptions } from './evidence-selection';

/** Detects a review's language (ISO 639-1), or null when it cannot tell. */
export function detectLanguage(text: string): string | null {
  return detect(text) || null;
}

/** Evidence-selection options from settings (spec 8, D-015). */
export function selectionOptions(config: AppConfig, maxReviews: number): SelectionOptions {
  return {
    maxReviews,
    minChars: config.EVIDENCE_MIN_REVIEW_CHARS,
    maxChars: config.EVIDENCE_MAX_REVIEW_CHARS,
    languages: config.EVIDENCE_LANGUAGES.split(','),
    detectLanguage,
  };
}

export function geminiClient(config: AppConfig): GeminiClient {
  return new GeminiClient({
    apiKey: config.GEMINI_API_KEY,
    timeoutMs: config.GEMINI_TIMEOUT_MS,
    maxRequestsPerMinute: config.GEMINI_MAX_REQUESTS_PER_MINUTE,
    tokensPerMinute: config.GEMINI_TOKENS_PER_MINUTE,
    transientRetries: config.GEMINI_TRANSIENT_RETRIES,
  });
}
