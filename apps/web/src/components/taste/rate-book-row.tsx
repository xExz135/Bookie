'use client';

import { useState } from 'react';
import { Cover } from '@/components/analysis/parts';
import { editionLine } from '@/components/discovery/candidate-card';
import { errorMessage } from '@/lib/api/errors';
import type { Candidate } from '@/lib/discovery/api';
import { type ProfileSaved, rateBook, removeRating } from '@/lib/taste/api';

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * One book to rate 1 to 5. Each choice is saved at once, so it is a button
 * press rather than a radio (arrow keys would save every step on the way).
 * Every save makes a new taste-profile version (D-018).
 */
export function RateBookRow({
  book,
  rating: initial,
  onSaved,
  removable = initial !== null,
}: {
  book: Candidate;
  rating: number | null;
  onSaved: (saved: ProfileSaved, rating: number | null) => void;
  removable?: boolean;
}) {
  const [rating, setRating] = useState<number | null>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: number | null) {
    setSaving(true);
    setError(null);
    try {
      const saved =
        next === null ? await removeRating(book.editionId) : await rateBook(book.editionId, next);
      setRating(next);
      onSaved(saved, next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Cover url={book.coverUrl} title={book.title} className="h-16 w-11 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="font-serif text-body-lg text-on-surface">{book.title}</span>
          {book.author ? (
            <span className="text-body-sm text-on-surface-variant">{book.author}</span>
          ) : null}
          <span className="text-label-sm text-on-surface-variant">{editionLine(book)}</span>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <div className="flex items-center gap-2">
          <div role="group" aria-label={`Your rating for ${book.title}`} className="flex">
            {STARS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={saving}
                aria-pressed={rating === n}
                aria-label={`${n} out of 5`}
                onClick={() => void save(n)}
                className={`px-1 text-headline-sm leading-none transition-colors disabled:opacity-60 ${
                  rating !== null && n <= rating
                    ? 'text-secondary'
                    : // An empty star is the control itself, so it needs 3:1 contrast (FE-11).
                      'text-outline hover:text-secondary'
                }`}
              >
                {rating !== null && n <= rating ? '★' : '☆'}
              </button>
            ))}
          </div>
          {removable && rating !== null ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(null)}
              className="text-label-md text-on-surface-variant underline underline-offset-4 hover:text-on-surface disabled:opacity-60"
            >
              Remove<span className="sr-only"> rating for {book.title}</span>
            </button>
          ) : null}
        </div>
        <p aria-live="polite" className="text-body-sm text-on-surface-variant">
          {saving ? 'Saving…' : rating !== null ? `You rated it ${rating} / 5` : 'Not rated'}
        </p>
        {error ? (
          <p role="alert" className="text-body-sm text-error">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
