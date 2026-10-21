/**
 * A live source could not be checked. Never read as "no data" (spec 8, 11):
 * the outcome is `failed` or `rate_limited`, and the caller retries later.
 * Messages never contain URLs or headers, because some carry API keys.
 */
export type SourceFailure = 'failed' | 'rate_limited';

export class SourceError extends Error {
  constructor(
    readonly outcome: SourceFailure,
    message: string,
    /** Short code stored as `review_fetches.error_code`, e.g. "timeout". */
    readonly code: string = outcome === 'rate_limited' ? 'rate_limited' : 'source_error',
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
