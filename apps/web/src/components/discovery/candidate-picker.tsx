'use client';

import { useId, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Candidate } from '@/lib/discovery/api';
import { CandidateCard, editionLine } from './candidate-card';

/**
 * The confirmation step (spec 6, DISC-2): the reader picks one book and
 * starts its analysis. Nothing is chosen for them when there is more than one
 * candidate; a single candidate is preselected but still needs the button.
 * The chosen edition is named before the analysis starts (DISC-5).
 */
export function CandidatePicker({
  candidates,
  legend,
  busy,
  error,
  onConfirm,
}: {
  candidates: Candidate[];
  legend: string;
  busy: boolean;
  error: string | null;
  onConfirm: (candidate: Candidate) => void;
}) {
  const name = useId();
  const [chosenId, setChosenId] = useState<string | null>(
    candidates.length === 1 ? candidates[0]!.editionId : null,
  );
  const chosen = candidates.find((c) => c.editionId === chosenId) ?? null;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen) onConfirm(chosen);
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{legend}</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {candidates.map((c) => (
            <CandidateCard
              key={c.editionId}
              candidate={c}
              name={name}
              selected={c.editionId === chosenId}
              onSelect={() => setChosenId(c.editionId)}
            />
          ))}
        </div>
      </fieldset>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-low p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-body-md text-on-surface" aria-live="polite">
          {chosen ? (
            <>
              <span className="font-semibold">{chosen.title}</span>
              {editionLine(chosen) ? (
                <span className="text-on-surface-variant"> · {editionLine(chosen)}</span>
              ) : null}
            </>
          ) : (
            <span className="text-on-surface-variant">Choose a book to continue.</span>
          )}
        </p>
        <Button type="submit" disabled={!chosen} busy={busy}>
          {busy ? 'Starting…' : 'Analyze this book'}
        </Button>
      </div>
    </form>
  );
}
