/**
 * Error codes and HTTP statuses from docs/CONTRACT.md section 2.
 * A test checks this table matches the contract document exactly.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SCAN_QUOTA_EXCEEDED: 429,
  UPLOAD_TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  NOT_A_BOOK: 422,
  UNREADABLE_IMAGE: 422,
  IDENTIFICATION_UNAVAILABLE: 503,
  SOURCES_UNAVAILABLE: 503,
  LLM_QUOTA_EXHAUSTED: 503,
  INVALID_MODEL_OUTPUT: 502,
  MODEL_UNAVAILABLE: 503,
  CONFLICT: 409,
  EMAIL_IN_USE: 409,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Safe default messages. The frontend maps `code` to its own wording. */
export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Some fields are invalid.',
  UNAUTHENTICATED: 'Please sign in.',
  TOKEN_EXPIRED: 'Your session expired.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  NOT_FOUND: 'Not found.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  SCAN_QUOTA_EXCEEDED: 'Scan limit reached.',
  UPLOAD_TOO_LARGE: 'The file is too large.',
  UNSUPPORTED_TYPE: 'This file type is not supported.',
  NOT_A_BOOK: 'This does not look like a book cover.',
  UNREADABLE_IMAGE: 'The image could not be read.',
  IDENTIFICATION_UNAVAILABLE: 'Cover identification is unavailable. Typed search still works.',
  SOURCES_UNAVAILABLE: 'Review sources are unavailable. This is not the same as having no reviews.',
  LLM_QUOTA_EXHAUSTED: 'Analysis capacity is used up for now. Try again later.',
  INVALID_MODEL_OUTPUT: 'A step failed. You can retry it.',
  MODEL_UNAVAILABLE: 'Personal matching is not available yet.',
  CONFLICT: 'This action conflicts with the current state.',
  EMAIL_IN_USE: 'An account with this email already exists.',
  INTERNAL_ERROR: 'Something went wrong on our side.',
};

/** Codes for which retrying the same request later can succeed. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'SCAN_QUOTA_EXCEEDED',
  'IDENTIFICATION_UNAVAILABLE',
  'SOURCES_UNAVAILABLE',
  'LLM_QUOTA_EXHAUSTED',
  'INVALID_MODEL_OUTPUT',
  'INTERNAL_ERROR',
]);
