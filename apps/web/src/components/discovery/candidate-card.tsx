'use client';

import { useState } from 'react';
import type { Candidate } from '@/lib/discovery/api';

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return null;
  }
})();

/** "en" → "English"; the tag itself when the browser does not know it. */
export function languageName(tag: string): string {
  try {
    return languageNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The edition in one line, from the fields the API returned: "Hardcover · Scholastic Inc · 1997 · English". */
export function editionLine(c: Candidate): string {
  return [c.format, c.publisher, c.year, c.language ? languageName(c.language) : null]
    .filter((part) => part !== null && part !== undefined && part !== '')
    .join(' · ');
}

/**
 * One book to choose (DISC-1): every identifying field the API returned, and
 * nothing for the ones it did not. A radio button, so choosing is a separate
 * step from starting the analysis.
 */
export function CandidateCard({
  candidate,
  name,
  selected,
  onSelect,
}: {
  candidate: Candidate;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const c = candidate;
  // Old dataset cover links often no longer load (D-014): show the tile instead of an empty box.
  const [coverFailed, setCoverFailed] = useState(false);
  const details: Array<[string, string]> = [];
  if (c.format) details.push(['Format', c.format]);
  if (c.language) details.push(['Language', languageName(c.language)]);
  if (c.year !== null) details.push(['Published', String(c.year)]);
  if (c.publisher) details.push(['Publisher', c.publisher]);

  return (
    <label
      className={`flex cursor-pointer flex-col gap-3 rounded-md border bg-surface-container-lowest p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-on-surface ${
        selected
          ? 'border-secondary bg-surface-container-low ring-1 ring-secondary'
          : 'border-outline-variant hover:bg-surface-container-low'
      }`}
    >
      <div className="flex gap-4 sm:flex-col">
        {c.coverUrl && !coverFailed ? (
          // Covers come from outside sites; a plain img avoids proxying them.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={c.coverUrl}
            alt={`Cover of ${c.title}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setCoverFailed(true)}
            className="h-36 w-24 shrink-0 rounded-sm bg-surface-container object-cover sm:h-56 sm:w-full sm:object-contain"
          />
        ) : (
          <div
            role="img"
            aria-label={`No cover available for ${c.title}`}
            className="flex h-36 w-24 shrink-0 items-center justify-center rounded-sm bg-surface-container px-2 text-center text-label-sm uppercase text-on-surface-variant sm:h-56 sm:w-full"
          >
            No cover
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          {c.publisher || c.year !== null ? (
            <p className="text-label-sm uppercase text-secondary">
              {[c.publisher, c.year].filter((v) => v !== null && v !== '').join(' · ')}
            </p>
          ) : null}
          <p className="font-serif text-headline-sm text-on-surface">{c.title}</p>
          {c.subtitle ? (
            <p className="font-serif text-body-md text-on-surface-variant">{c.subtitle}</p>
          ) : null}
          {c.author ? <p className="text-body-md text-on-surface-variant">{c.author}</p> : null}
        </div>
      </div>
      {details.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-outline-variant/60 pt-3 text-body-sm">
          {details.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-on-surface-variant">{term}</dt>
              <dd className="text-right text-on-surface">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <span className="mt-auto flex items-center gap-2 text-label-lg text-on-surface">
        <input
          type="radio"
          name={name}
          value={c.editionId}
          checked={selected}
          onChange={onSelect}
          className="size-4 accent-secondary"
        />
        {selected ? 'Selected' : 'Choose this book'}
      </span>
    </label>
  );
}
