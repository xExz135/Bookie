'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from '@/lib/config';
import { type CatalogSearchResult, searchCatalog } from '@/lib/taste/api';
import { RateBookRow } from './rate-book-row';
import { TasteProgress } from './taste-progress';
import { useTasteProfile } from './use-taste';

/**
 * Quick rate (spec 6, ONB-2): the most-rated books first, or a search, each
 * rated 1 to 5 in place. Progress toward a confident match updates with
 * every save.
 */
export function QuickRate() {
  const taste = useTasteProfile();
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState<string | undefined>();
  const [shown, setShown] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogSearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  async function load(q: string | null) {
    setLoading(true);
    setError(null);
    try {
      setResult(await searchCatalog(q ?? undefined));
      setShown(q);
    } catch (e) {
      if (e instanceof ApiRequestError && e.fields.q) setQueryError(e.fields.q);
      else setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    searchCatalog().then(
      (r) => {
        if (cancelled) return;
        setResult(r);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q.length === 0) {
      setQueryError(undefined);
      void load(null);
      return;
    }
    if (q.length < SEARCH_MIN_LENGTH) {
      setQueryError('Type at least 2 letters or digits.');
      return;
    }
    setQueryError(undefined);
    void load(q);
  }

  const external = result?.external;

  return (
    <section aria-labelledby="rate-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href="/taste" className="text-label-md text-secondary underline underline-offset-4">
          Your taste profile
        </Link>
        <h1
          id="rate-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Quick rate
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Rate books you have read, from 1 star (did not like it) to 5 (loved it). Each rating is
          saved as you go.
        </p>
      </header>

      {taste.profile ? (
        <div className="rounded-md border border-outline-variant bg-surface-container-lowest p-5">
          <TasteProgress profile={taste.profile} />
        </div>
      ) : null}

      <form
        onSubmit={submit}
        role="search"
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <TextField
            label="Find a book you have read"
            name="q"
            value={query}
            maxLength={SEARCH_MAX_LENGTH}
            onChange={(e) => setQuery(e.target.value)}
            error={queryError}
            hint="Title, author or ISBN. Leave empty for the most-read books."
          />
        </div>
        <Button type="submit" busy={loading} className="sm:mb-6">
          Search
        </Button>
      </form>

      {error ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{errorMessage(error)}</Alert>
          <Button variant="secondary" onClick={() => void load(shown)}>
            Try again
          </Button>
        </div>
      ) : null}

      {!result && loading ? (
        <p role="status" className="text-body-md text-on-surface-variant">
          Loading books…
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-label-md uppercase text-on-surface-variant" aria-live="polite">
            {shown ? `Books matching “${shown}”` : 'Most-read books'}
          </h2>
          {external && (external.outcome === 'failed' || external.outcome === 'rate_limited') ? (
            <Alert tone="info">
              We could not check Open Library just now, so a book you are looking for may still
              exist. Try again in a few minutes.
            </Alert>
          ) : null}
          {result.items.length === 0 ? (
            <p className="text-body-md text-on-surface-variant">
              No books match that. Try a shorter title or the author&rsquo;s name.
            </p>
          ) : (
            <ul aria-label="Books to rate" className="flex flex-col gap-2">
              {result.items.map((book) => (
                <RateBookRow
                  key={`${shown ?? ''}-${book.editionId}`}
                  book={book}
                  rating={book.yourRating}
                  onSaved={taste.saved}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
