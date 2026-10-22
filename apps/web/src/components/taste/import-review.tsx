'use client';

import { useState } from 'react';
import { Cover } from '@/components/analysis/parts';
import { editionLine } from '@/components/discovery/candidate-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FIELD_BORDER } from '@/components/ui/text-field';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from '@/lib/config';
import { type Candidate, searchBooks } from '@/lib/discovery/api';
import type { RatingImport, Resolution, UnmatchedRow } from '@/lib/taste/api';

const FORMAT_NAMES = { goodreads: 'Goodreads', storygraph: 'StoryGraph' } as const;

/** The reader's choice for one unmatched row: a book, or skip. */
type Choice = string | 'skip';

/**
 * Import review (spec 6, ONB-1, FE-3): what matched, what was ignored, and
 * every row that did not match. For each one the reader picks one of the
 * suggested books, searches for it, or skips it. Nothing is chosen for them,
 * and every row is sent with its choice, so nothing is dropped silently.
 */
export function ImportReview({
  data,
  saving,
  error,
  onSave,
  onCancel,
}: {
  data: RatingImport;
  saving: boolean;
  error: string | null;
  onSave: (resolutions: Resolution[], count: number) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const chosen = data.unmatched.filter((row) => (choices[row.rowIndex] ?? 'skip') !== 'skip');
  const count = data.matchedCount + chosen.length;

  if (data.status === 'confirmed') {
    return <Alert tone="success">This import was already saved.</Alert>;
  }

  function save() {
    const resolutions: Resolution[] = data.unmatched.map((row) => {
      const choice = choices[row.rowIndex] ?? 'skip';
      return choice === 'skip'
        ? { rowIndex: row.rowIndex, skip: true as const }
        : { rowIndex: row.rowIndex, editionId: choice };
    });
    onSave(resolutions, count);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
        <h2 className="font-serif text-headline-sm text-on-surface">
          {data.format ? `${FORMAT_NAMES[data.format]} export` : 'Your export'} is ready
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-md">
          <dt className="text-on-surface-variant">Rated rows</dt>
          <dd className="text-on-surface">{data.totalRows}</dd>
          <dt className="text-on-surface-variant">Matched to a book</dt>
          <dd className="text-on-surface">{data.matchedCount}</dd>
          <dt className="text-on-surface-variant">Not matched</dt>
          <dd className="text-on-surface">{data.unmatched.length}</dd>
          <dt className="text-on-surface-variant">Ignored, no rating</dt>
          <dd className="text-on-surface">{data.ignoredRows}</dd>
        </dl>
        {data.ignoredRows > 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            Rows without a star rating (for example books on a to-read shelf) are not used.
          </p>
        ) : null}
      </div>

      {data.unmatched.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h2 className="font-serif text-headline-sm text-on-surface">
            Not matched ({data.unmatched.length})
          </h2>
          <p className="text-body-md text-on-surface-variant">
            We could not be sure which book these rows mean. Choose the right one, search for it, or
            skip it. Skipped rows are not saved; you can rate them later with Quick rate.
          </p>
          <ul aria-label="Rows not matched" className="flex flex-col gap-3">
            {data.unmatched.map((row) => (
              <UnmatchedRowChoice
                key={row.rowIndex}
                row={row}
                choice={choices[row.rowIndex] ?? 'skip'}
                disabled={saving}
                onChoose={(choice) => setChoices((c) => ({ ...c, [row.rowIndex]: choice }))}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col items-start gap-3">
        <p aria-live="polite" className="text-body-md text-on-surface">
          {count} {count === 1 ? 'rating' : 'ratings'} will be saved
          {data.unmatched.length > 0
            ? `; ${data.unmatched.length - chosen.length} ${data.unmatched.length - chosen.length === 1 ? 'row' : 'rows'} skipped`
            : ''}
          .
        </p>
        <div className="flex flex-wrap gap-3">
          <Button busy={saving} onClick={save} disabled={count === 0}>
            {saving ? 'Saving…' : `Save ${count} ${count === 1 ? 'rating' : 'ratings'}`}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Upload a different file
          </Button>
        </div>
        {count === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            Nothing is matched or chosen yet, so there is nothing to save.
          </p>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </div>
  );
}

/** One unmatched row: its suggestions, a search of its own, and skip. */
function UnmatchedRowChoice({
  row,
  choice,
  disabled,
  onChoose,
}: {
  row: UnmatchedRow;
  choice: Choice;
  disabled: boolean;
  onChoose: (choice: Choice) => void;
}) {
  const name = `row-${row.rowIndex}`;
  const [query, setQuery] = useState([row.rawTitle, row.rawAuthor].filter(Boolean).join(' '));
  const [found, setFound] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);

  // Suggestions first, then search results that are not already suggested.
  const known = new Set(row.candidates.map((c) => c.editionId));
  const options = [...row.candidates, ...found.filter((c) => !known.has(c.editionId))];

  async function search() {
    const q = query.trim();
    if (q.length < SEARCH_MIN_LENGTH) {
      setSearchNote('Type at least 2 letters or digits.');
      return;
    }
    setSearching(true);
    setSearchNote(null);
    try {
      const result = await searchBooks(q);
      setFound(result.candidates);
      setSearched(true);
      const unchecked =
        result.external?.outcome === 'failed' || result.external?.outcome === 'rate_limited';
      if (result.candidates.length === 0) {
        setSearchNote(
          unchecked
            ? 'Nothing found, and Open Library could not be checked just now, so the book may still exist. Try again in a few minutes.'
            : 'Nothing found. Try a shorter title or only the author.',
        );
      } else if (unchecked) {
        setSearchNote('Open Library could not be checked just now; more books may exist.');
      }
    } catch (e) {
      setSearchNote(e instanceof ApiRequestError && e.fields.q ? e.fields.q : errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <li className="rounded-md border border-outline-variant bg-surface-container-lowest p-4">
      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="flex flex-col gap-0.5">
          <span className="font-serif text-body-lg text-on-surface">{row.rawTitle}</span>
          <span className="text-body-sm text-on-surface-variant">
            {row.rawAuthor ? `${row.rawAuthor} · ` : ''}your rating {row.rating} / 5
          </span>
        </legend>

        {options.length > 0 ? (
          <div className="flex flex-col gap-2">
            {options.map((book) => (
              <label
                key={book.editionId}
                className="flex cursor-pointer items-center gap-3 rounded-sm border border-outline-variant px-3 py-2 has-[:checked]:border-secondary has-[:checked]:bg-secondary-fixed/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-on-surface"
              >
                <input
                  type="radio"
                  name={name}
                  value={book.editionId}
                  checked={choice === book.editionId}
                  onChange={() => onChoose(book.editionId)}
                  className="size-4 shrink-0 accent-secondary"
                />
                <Cover url={book.coverUrl} title={book.title} className="h-12 w-8 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body-md text-on-surface">
                    {book.title}
                    {book.subtitle ? `: ${book.subtitle}` : ''}
                  </span>
                  <span className="text-body-sm text-on-surface-variant">
                    {[book.author, editionLine(book)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-body-sm text-on-surface-variant">
            {searched ? '' : 'No close match was suggested. Search for it below, or skip it.'}
          </p>
        )}

        <label className="flex cursor-pointer items-center gap-3 rounded-sm border border-outline-variant px-3 py-2 text-body-md has-[:checked]:border-on-surface-variant has-[:checked]:bg-surface-container-low has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-on-surface">
          <input
            type="radio"
            name={name}
            value="skip"
            checked={choice === 'skip'}
            onChange={() => onChoose('skip')}
            className="size-4 shrink-0 accent-secondary"
          />
          Skip this row
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="search"
              aria-label={`Find the book for ${row.rawTitle}`}
              value={query}
              maxLength={SEARCH_MAX_LENGTH}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter searches this row instead of submitting anything else.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void search();
                }
              }}
              className={`min-w-0 flex-1 rounded-sm border ${FIELD_BORDER} bg-surface-container-lowest px-3 py-2 text-body-md text-on-surface outline-none focus:border-transparent focus:ring-[1.5px] focus:ring-on-surface`}
            />
            <Button variant="secondary" busy={searching} onClick={() => void search()}>
              {searching ? 'Searching…' : 'Search'}
              <span className="sr-only"> for {row.rawTitle}</span>
            </Button>
          </div>
          {searchNote ? (
            <p role="status" className="text-body-sm text-on-surface-variant">
              {searchNote}
            </p>
          ) : null}
        </div>
      </fieldset>
    </li>
  );
}
