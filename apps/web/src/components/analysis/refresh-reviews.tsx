'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/analysis/labels';
import { ApiRequestError, errorMessage, waitText } from '@/lib/api/errors';
import { startAnalysis } from '@/lib/discovery/api';

/**
 * Builds the public reception of a book again (spec 10 user refresh, D-025)
 * and opens the new analysis. The current result stays as it was generated.
 */
export function useRefreshReviews() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(editionId: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await startAnalysis(editionId, { refresh: true });
      router.push(`/analyses/${next.id}`);
    } catch (e) {
      // The API limits refreshes per book per day (and analyses per hour): both are 429.
      setError(
        e instanceof ApiRequestError && e.code === 'RATE_LIMITED'
          ? `The reviews of this book cannot be refreshed again yet. Try again ${waitText(e.body?.retryAfterSeconds)}.`
          : errorMessage(e),
      );
      setBusy(false);
    }
  }

  return { refresh, busy, error };
}

/**
 * When the reviews were gathered, and the way to gather them again. The date
 * is the API's `generatedAt`; whether reviews are old enough to refresh is
 * the reader's call, the screen does not judge it.
 */
export function RefreshReviews({
  generatedAt,
  available,
  busy,
  error,
  onRefresh,
}: {
  generatedAt: string | null;
  /** Off while the analysis runs. */
  available: boolean;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-outline-variant/60 pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-body-sm text-on-surface-variant">
          {generatedAt ? `Reviews gathered ${formatDate(generatedAt)}. ` : null}
          Refreshing asks every source again and makes a new result; this one stays as it is.
        </p>
        {available ? (
          <Button variant="secondary" busy={busy} onClick={onRefresh} className="shrink-0">
            {busy ? 'Refreshing…' : 'Refresh reviews'}
          </Button>
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
