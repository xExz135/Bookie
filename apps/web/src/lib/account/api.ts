import { api, call } from '@/lib/api/client';

/**
 * Delete my data (CONTRACT 4.5, SEC-3, D-022): removes the reader's ratings,
 * taste-profile versions, imports, analyses, feedback and reading list. The
 * account stays signed in and onboarding starts again.
 */
export function deleteMyData(password: string): Promise<void> {
  return call(api.DELETE('/api/v1/me/data', { body: { password } })).then(() => undefined);
}
