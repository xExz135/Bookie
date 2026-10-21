'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/errors';
import { addToReadingList, getReadingList, removeFromReadingList } from '@/lib/reading-list/api';

type State = 'checking' | 'saved' | 'not_saved';

/**
 * Saves the book on the result screen to the reading list, or removes it
 * (spec 6). Whether it is already there comes from the list; if the list
 * cannot be read the button still works, because saving twice is harmless.
 */
export function SaveToReadingList({ editionId }: { editionId: string }) {
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getReadingList().then(
      (list) => {
        if (cancelled) return;
        const there = list.items.some((i) => i.edition.editionId === editionId);
        setState(there ? 'saved' : 'not_saved');
      },
      () => {
        if (!cancelled) setState('not_saved');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [editionId]);

  async function change(save: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (save) await addToReadingList(editionId);
      else await removeFromReadingList(editionId);
      setState(save ? 'saved' : 'not_saved');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {state === 'saved' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p role="status" className="text-label-lg text-on-surface">
            On your reading list
          </p>
          <Link
            href="/reading-list"
            className="text-label-lg text-secondary underline underline-offset-4"
          >
            Open the reading list
          </Link>
          <Button variant="link" busy={busy} onClick={() => void change(false)}>
            {busy ? 'Removing…' : 'Remove from reading list'}
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          busy={busy}
          disabled={state === 'checking'}
          onClick={() => void change(true)}
        >
          {busy ? 'Saving…' : 'Save to reading list'}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
