import createClient from 'openapi-fetch';
import type { paths } from '@/api/schema';
import { API_URL } from '@/lib/config';
import { Session } from '@/lib/auth/session';
import { ApiRequestError } from './errors';
import type { ErrorBody } from './types';

/** The one session for this tab. Its token never leaves memory. */
export const session = new Session({
  apiUrl: API_URL,
  // Bound so the browser's fetch keeps its `this`.
  fetch: (...args) => globalThis.fetch(...args),
  locks: typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined,
});

/**
 * Typed client generated from contract/openapi.json. Every call goes through
 * the session, which adds the token and handles silent refresh.
 */
export const api = createClient<paths>({
  baseUrl: API_URL,
  credentials: 'include',
  fetch: session.fetch,
});

/**
 * Unwraps an openapi-fetch result: the data, or an ApiRequestError with the
 * contract error body (null body when the API could not be reached).
 */
export async function call<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result;
  try {
    result = await promise;
  } catch {
    throw new ApiRequestError(0, null);
  }
  if (result.response.ok) return result.data as T;
  const body = result.error as ErrorBody | undefined;
  throw new ApiRequestError(
    result.response.status,
    body && typeof body === 'object' && 'code' in body ? body : null,
  );
}
