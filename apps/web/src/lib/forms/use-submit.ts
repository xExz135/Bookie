'use client';

import { useCallback, useState } from 'react';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';

/**
 * Form submission state: busy flag, the error message for the whole form,
 * and per-field messages from VALIDATION_FAILED (CONTRACT 2).
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const fields = error instanceof ApiRequestError ? error.fields : {};
  const code = error instanceof ApiRequestError ? error.code : null;
  return { busy, run, error, code, fields, message: error ? errorMessage(error) : null };
}
