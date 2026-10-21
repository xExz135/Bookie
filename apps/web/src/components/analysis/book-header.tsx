import { languageName } from '@/components/discovery/candidate-card';
import type { Analysis } from '@/lib/analysis/api';
import { ExpandableText } from './expandable-text';
import { Cover } from './parts';

/**
 * The edition analysed (DISC-5): every identifying field the API returned,
 * and a note that the result is about this edition.
 */
export function BookHeader({
  edition,
  actions,
}: {
  edition: Analysis['edition'];
  /** Controls for this book, such as saving it to the reading list. */
  actions?: React.ReactNode;
}) {
  const facts = [
    edition.format,
    edition.isbn13 ? `ISBN ${edition.isbn13}` : null,
    edition.year !== null ? String(edition.year) : null,
    edition.pageCount !== null ? `${edition.pageCount} pages` : null,
    edition.language ? languageName(edition.language) : null,
  ].filter((fact): fact is string => !!fact);

  return (
    <div className="flex flex-col gap-6 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:flex-row sm:p-6">
      <Cover
        url={edition.coverUrl}
        title={edition.title}
        className="h-48 w-32 shrink-0 self-start sm:h-64 sm:w-44"
      />
      <div className="flex min-w-0 flex-col gap-3">
        {facts.length > 0 ? (
          <ul aria-label="Edition details" className="flex flex-wrap gap-1.5">
            {facts.map((fact) => (
              <li
                key={fact}
                className="rounded-sm border border-outline-variant px-2 py-0.5 text-label-sm uppercase text-on-surface-variant"
              >
                {fact}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg">
            {edition.title}
          </h1>
          {edition.subtitle ? (
            <p className="font-serif text-body-lg text-on-surface-variant">{edition.subtitle}</p>
          ) : null}
          {edition.author ? (
            <p className="font-serif text-body-lg italic text-on-surface-variant">
              by {edition.author}
            </p>
          ) : null}
        </div>
        {edition.description ? (
          <ExpandableText
            text={edition.description}
            lines={6}
            moreLabel="Show the full description"
            className="max-w-prose whitespace-pre-line font-serif text-body-lg text-on-surface"
          />
        ) : null}
        {actions}
        <p className="rounded-sm bg-surface-container-low px-4 py-3 text-body-sm text-on-surface-variant">
          <span className="text-label-md uppercase text-on-surface">About this edition: </span>
          This result is about this edition
          {edition.publisher ? ` from ${edition.publisher}` : ''}. Other editions are analysed
          separately. Ratings marked &ldquo;all editions&rdquo; cover every edition of the book.
        </p>
      </div>
    </div>
  );
}
