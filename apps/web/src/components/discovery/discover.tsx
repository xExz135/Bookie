'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { SEARCH_MIN_LENGTH } from '@/lib/config';
import {
  type BookSearchResult,
  type Candidate,
  type ScanResult,
  scanCover,
  searchBooks,
  startAnalysis,
} from '@/lib/discovery/api';
import {
  COVER_PROBLEM_MESSAGES,
  CoverFileError,
  prepareCover,
} from '@/lib/discovery/prepare-cover';
import { CandidatePicker } from './candidate-picker';
import { ScanPanel } from './scan-panel';
import { SearchPanel } from './search-panel';

type Results =
  | { kind: 'none' }
  | { kind: 'search'; query: string; result: BookSearchResult }
  | { kind: 'scan'; result: ScanResult };

/** Open Library could not be checked: the book may exist (CONTRACT 4.3). Never "no such book". */
function sourceUnchecked(external: BookSearchResult['external']): boolean {
  return external?.outcome === 'failed' || external?.outcome === 'rate_limited';
}

const UNCHECKED_MESSAGE =
  'We could not check Open Library just now, so this book may still exist. Try again in a few minutes.';

/** What the cover said, as a search: title and first author, as the API read them. */
function recognizedQuery(result: ScanResult): string {
  return [result.recognized.title, result.recognized.authors[0]].filter(Boolean).join(' ');
}

/** Covers the API could not use: the reader is sent to typed search (spec 6). */
const TYPE_INSTEAD = new Set(['NOT_A_BOOK', 'UNREADABLE_IMAGE']);

/**
 * Discovery (spec 6, FE-4): typed search, cover scan, then confirmation of
 * one book, which starts its analysis. Everything shown comes from the API;
 * the page only decides which message fits which outcome.
 */
export function Discover() {
  const router = useRouter();
  const searchInput = useRef<HTMLInputElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);

  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<Results>({ kind: 'none' });
  // A new key per result set, so the picker starts with nothing chosen again.
  const [resultsKey, setResultsKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Move focus to new results so keyboard and screen-reader users land on them.
  useEffect(() => {
    if (results.kind !== 'none') resultsHeading.current?.focus();
  }, [results]);

  function show(next: Results) {
    setResults(next);
    setResultsKey((k) => k + 1);
    setStartError(null);
  }

  function focusSearch() {
    searchInput.current?.focus();
  }

  async function search() {
    const q = query.trim();
    setNotice(null);
    if (q.length < SEARCH_MIN_LENGTH) {
      setQueryError('Type at least 2 letters or digits.');
      focusSearch();
      return;
    }
    setQueryError(undefined);
    setSearching(true);
    try {
      show({ kind: 'search', query: q, result: await searchBooks(q) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.fields.q) setQueryError(error.fields.q);
      else setNotice(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }

  async function scan(file: File) {
    setNotice(null);
    setScanning(true);
    show({ kind: 'none' });
    try {
      const jpeg = await prepareCover(file);
      const result = await scanCover(jpeg);
      if (result.outcome === 'uncertain' && result.candidates.length === 0) {
        // Offer a typed search prefilled from what the cover said (CONTRACT 4.3).
        setQuery(recognizedQuery(result));
      }
      show({ kind: 'scan', result });
    } catch (error) {
      if (error instanceof CoverFileError) {
        setNotice(COVER_PROBLEM_MESSAGES[error.problem]);
        if (error.problem === 'unreadable') focusSearch();
      } else {
        setNotice(errorMessage(error));
        if (error instanceof ApiRequestError && TYPE_INSTEAD.has(error.code ?? '')) focusSearch();
      }
    } finally {
      setScanning(false);
    }
  }

  async function confirm(candidate: Candidate) {
    setStarting(true);
    setStartError(null);
    try {
      const analysis = await startAnalysis(candidate.editionId);
      router.push(`/analyses/${analysis.id}`);
    } catch (error) {
      setStartError(
        error instanceof ApiRequestError && error.code === 'NOT_FOUND'
          ? 'We could not find that book any more. Please search again.'
          : errorMessage(error),
      );
      setStarting(false);
    }
  }

  const picker = (candidates: Candidate[], legend: string) => (
    <CandidatePicker
      key={resultsKey}
      candidates={candidates}
      legend={legend}
      busy={starting}
      error={startError}
      onConfirm={(c) => void confirm(c)}
    />
  );

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <p className="text-label-md uppercase text-secondary">Find your next book</p>
        <h1 className="font-serif text-headline-lg-mobile text-on-surface sm:text-display-lg">
          Should you read this book?
        </h1>
        <p className="max-w-2xl font-serif text-body-lg text-on-surface-variant">
          See what readers say about a book and, once you have rated a few books, how close it is to
          your taste. Search by title, author or ISBN, or scan the cover.
        </p>
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-label-md text-on-surface-variant">
          <li>1. Find the book</li>
          <li aria-hidden="true">→</li>
          <li>2. Confirm it</li>
          <li aria-hidden="true">→</li>
          <li>3. See the result</li>
        </ol>
      </header>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <SearchPanel
            query={query}
            busy={searching}
            error={queryError}
            inputRef={searchInput}
            onQueryChange={(q) => {
              setQuery(q);
              setQueryError(undefined);
            }}
            onSearch={() => void search()}
          />
        </div>
        <div className="lg:col-span-2">
          <ScanPanel busy={scanning} onPhoto={(file) => void scan(file)} />
        </div>
      </div>

      <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
        {scanning ? (
          <p role="status" className="text-body-md text-on-surface-variant">
            Reading the cover…
          </p>
        ) : null}
        {notice ? <Alert>{notice}</Alert> : null}
      </div>

      {results.kind !== 'none' ? (
        <section aria-labelledby="results-heading" className="flex flex-col gap-5">
          <ResultsIntro results={results} headingRef={resultsHeading} />
          {results.kind === 'scan' && results.result.candidates.length === 0 ? (
            <div>
              <Button type="button" variant="secondary" onClick={focusSearch}>
                Edit the search
              </Button>
            </div>
          ) : null}
          {results.kind === 'search' && results.result.candidates.length > 0
            ? picker(results.result.candidates, 'Books matching your search')
            : null}
          {results.kind === 'scan' && results.result.candidates.length > 0 ? (
            <>
              {picker(results.result.candidates, 'Books matching the cover')}
              <p className="text-body-sm text-on-surface-variant">
                Not your book?{' '}
                <button
                  type="button"
                  className="text-secondary underline underline-offset-4"
                  onClick={() => {
                    setQuery(recognizedQuery(results.result));
                    focusSearch();
                  }}
                >
                  Search by title instead
                </button>
              </p>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ResultsIntro({
  results,
  headingRef,
}: {
  results: Exclude<Results, { kind: 'none' }>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  let heading: string;
  let text: React.ReactNode;
  let unchecked = false;

  if (results.kind === 'search') {
    const { candidates, external } = results.result;
    if (candidates.length > 0) {
      heading = 'Which book do you mean?';
      text = `${candidates.length === 1 ? 'One book matches' : `${candidates.length} books match`} “${results.query}”. Choose yours to continue.`;
    } else {
      heading = 'No books found';
      unchecked = sourceUnchecked(external);
      text = unchecked
        ? null
        : `Nothing matches “${results.query}”. Check the spelling, or try the author's name or the ISBN.`;
    }
  } else {
    const { outcome, candidates, recognized, external } = results.result;
    const read = `“${recognized.title}”${recognized.authors.length ? ` by ${recognized.authors.join(', ')}` : ''}`;
    if (candidates.length === 0) {
      heading = 'We could not match this cover';
      unchecked = sourceUnchecked(external);
      text = `The cover reads ${read}. We put that in the search box so you can correct it and search.`;
    } else if (outcome === 'identified') {
      heading = 'Is this your book?';
      text = `The cover reads ${read}. Check that this is your book before we analyze it.`;
    } else {
      heading = 'Which book is it?';
      text = `The cover reads ${read}, but we cannot be sure which book it is. Choose yours to continue.`;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h2
        id="results-heading"
        ref={headingRef}
        tabIndex={-1}
        className="font-serif text-headline-md text-on-surface outline-none"
      >
        {heading}
      </h2>
      {text ? <p className="text-body-md text-on-surface-variant">{text}</p> : null}
      {unchecked ? <Alert tone="info">{UNCHECKED_MESSAGE}</Alert> : null}
    </div>
  );
}
