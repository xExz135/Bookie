'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRecalculate } from '@/components/analysis/recalculate';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { type AnalysisSummary, listAnalyses } from '@/lib/analysis/api';
import { errorMessage } from '@/lib/api/errors';
import { HistoryRow } from './history-row';

/**
 * History (spec 6, FE-7): every analysis the reader started, newest first as
 * the API orders them, including ones still running (RES-1). Older results
 * whose taste profile has changed can be recalculated (ONB-4).
 */
export function History() {
  const [items, setItems] = useState<AnalysisSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloads, setReloads] = useState(0);
  const recalc = useRecalculate();

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    listAnalyses().then(
      (page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listAnalyses(nextCursor);
      // Skip any row already shown, in case one moved between pages.
      setItems((current) => {
        const seen = new Set((current ?? []).map((i) => i.id));
        return [...(current ?? []), ...page.items.filter((i) => !seen.has(i.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-label-sm uppercase text-secondary">Your reading archive</p>
        <h1
          id="history-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          History
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Every book you have analyzed, newest first. Each result opens as it was made.
        </p>
      </header>

      {items === null ? (
        loadError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>{errorMessage(loadError)}</Alert>
            <Button variant="secondary" onClick={() => setReloads((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-body-md text-on-surface-variant">
            Loading your history…
          </p>
        )
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-6">
          <p className="font-serif text-headline-sm text-on-surface">No analyses yet</p>
          <p className="text-body-md text-on-surface-variant">
            Search for a book or photograph its cover, and its result will be kept here.
          </p>
          <Link href="/" className="text-label-lg text-secondary underline underline-offset-4">
            Find a book
          </Link>
        </div>
      ) : (
        <>
          <ul aria-label="Analyses" className="flex flex-col gap-4">
            {items.map((item) => (
              <HistoryRow
                key={item.id}
                item={item}
                recalculating={recalc.busy(item.id)}
                recalculateError={recalc.errorFor(item.id)}
                onRecalculate={() => void recalc.recalculate(item.id)}
              />
            ))}
          </ul>
          {nextCursor ? (
            <div className="flex flex-col items-start gap-3">
              <Button variant="secondary" busy={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </Button>
              {moreError ? <Alert>{errorMessage(moreError)}</Alert> : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
