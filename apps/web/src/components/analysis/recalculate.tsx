'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { recalculateAnalysis } from '@/lib/analysis/api';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';

/**
 * Recalculates a result for the current taste profile (ONB-4) and opens the
 * new analysis. The old result stays as it was generated.
 */
export function useRecalculate() {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  async function recalculate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const next = await recalculateAnalysis(id);
      router.push(`/analyses/${next.id}`);
    } catch (e) {
      const message =
        e instanceof ApiRequestError && e.code === 'CONFLICT'
          ? 'This result already uses your current taste profile.'
          : errorMessage(e);
      setError({ id, message });
      setBusyId(null);
    }
  }

  return {
    recalculate,
    busy: (id: string) => busyId === id,
    errorFor: (id: string) => (error?.id === id ? error.message : null),
  };
}

/**
 * Said when the taste profile changed after this result was made (ONB-4),
 * with both versions as the API reports them and the way to recalculate.
 * A result made before any rating has no version (`null`).
 */
export function OutdatedNotice({
  usedVersion,
  currentVersion,
  busy,
  error,
  onRecalculate,
}: {
  usedVersion: number | null;
  currentVersion: number;
  busy: boolean;
  error: string | null;
  onRecalculate: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-secondary/30 bg-secondary-fixed/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-body-md text-on-surface">
        <span className="text-label-md uppercase text-on-secondary-fixed-variant">
          Taste profile updated.{' '}
        </span>
        {usedVersion === null
          ? `This result was made before you had rated any books; your taste profile is now version ${currentVersion}.`
          : `This personal match used taste profile version ${usedVersion}; yours is now version ${currentVersion}.`}{' '}
        Recalculating makes a new result and keeps this one as it is.
      </p>
      <Button variant="primary" busy={busy} onClick={onRecalculate} className="shrink-0">
        {busy ? 'Recalculating…' : 'Recalculate'}
      </Button>
      {error ? (
        <div className="sm:basis-full">
          <Alert>{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}
