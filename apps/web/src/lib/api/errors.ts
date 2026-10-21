import type { ErrorBody, ErrorCode } from './types';

/**
 * A failed API call. `body` is the contract error (CONTRACT 2), or null when
 * the API could not be reached at all.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody | null,
  ) {
    super(body?.code ?? 'NETWORK_ERROR');
    this.name = 'ApiRequestError';
  }

  get code(): ErrorCode | null {
    return this.body?.code ?? null;
  }

  /** Field messages for VALIDATION_FAILED, keyed by field name. */
  get fields(): Record<string, string> {
    return this.body?.fields ?? {};
  }
}

function waitText(seconds: number | undefined): string {
  if (!seconds || seconds < 60) return 'in a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Our wording for each contract code. The API's own `message` is only a
 * fallback (CONTRACT 2: the frontend maps `code` to its own wording). Typed
 * against the generated code list, so a new code fails the build here.
 */
const MESSAGES: Record<ErrorCode, (body: ErrorBody) => string> = {
  VALIDATION_FAILED: () => 'Please check the highlighted fields.',
  UNAUTHENTICATED: () => 'Please sign in to continue.',
  TOKEN_EXPIRED: () => 'Your session ended. Please sign in again.',
  INVALID_CREDENTIALS: () => 'That email and password do not match an account.',
  NOT_FOUND: () => 'We could not find that.',
  RATE_LIMITED: (b) => `Too many attempts. Try again ${waitText(b.retryAfterSeconds)}.`,
  SCAN_QUOTA_EXCEEDED: (b) =>
    `You have used today's scans. Try again ${waitText(b.retryAfterSeconds)}, or type the title.`,
  UPLOAD_TOO_LARGE: () => 'That file is too large.',
  UNSUPPORTED_TYPE: () => 'That type of file is not supported.',
  NOT_A_BOOK: () => 'That does not look like a book cover. Try typing the title instead.',
  UNREADABLE_IMAGE: () => 'We could not read that photo. Try typing the title instead.',
  IDENTIFICATION_UNAVAILABLE: () =>
    'Cover scanning is unavailable right now. Typed search still works.',
  SOURCES_UNAVAILABLE: () =>
    'Review sources could not be reached. This does not mean there are no reviews.',
  LLM_QUOTA_EXHAUSTED: () => 'Analysis is paused for now. Try again later.',
  INVALID_MODEL_OUTPUT: () => 'A step failed. You can retry it.',
  CONFLICT: () => 'That cannot be done right now.',
  EMAIL_IN_USE: () => 'An account with this email already exists.',
  INTERNAL_ERROR: () => 'Something went wrong on our side. Please try again.',
};

export const NETWORK_MESSAGE =
  'We cannot reach Bookie right now. Check your connection and try again.';

/** A message for any error thrown by an API call. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (!error.body) return NETWORK_MESSAGE;
    const message = MESSAGES[error.body.code];
    return message ? message(error.body) : error.body.message;
  }
  return MESSAGES.INTERNAL_ERROR({} as ErrorBody);
}
