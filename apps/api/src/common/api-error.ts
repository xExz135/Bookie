import { DEFAULT_MESSAGES, ERROR_CODES, RETRYABLE, type ErrorCode } from '../contract/error-codes';

/** The body of every non-2xx response (CONTRACT section 2). */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  fields?: Record<string, string>;
}

/** Throw this from any handler to return a contract-shaped error. */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly options: {
      message?: string;
      retryAfterSeconds?: number;
      fields?: Record<string, string>;
    } = {},
  ) {
    super(options.message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ApiError';
    this.status = ERROR_CODES[code];
  }

  toBody(): ErrorBody {
    return errorBody(this.code, this.options);
  }
}

export function errorBody(
  code: ErrorCode,
  options: { message?: string; retryAfterSeconds?: number; fields?: Record<string, string> } = {},
): ErrorBody {
  const body: ErrorBody = {
    code,
    message: options.message ?? DEFAULT_MESSAGES[code],
    retryable: RETRYABLE.has(code),
  };
  if (options.retryAfterSeconds !== undefined) body.retryAfterSeconds = options.retryAfterSeconds;
  // `fields` is present only for VALIDATION_FAILED (CONTRACT section 2).
  if (code === 'VALIDATION_FAILED') body.fields = options.fields ?? {};
  return body;
}
