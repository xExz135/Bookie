'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/analysis/labels';
import { listRatings, type RatedBook, type TasteProfile } from '@/lib/taste/api';
import { RateBookRow } from './rate-book-row';
import { TasteProgress } from './taste-progress';
import { useTasteProfile } from './use-taste';

const ACTIONS = [
  { href: '/taste/import', title: 'Import ratings', text: 'Goodreads or StoryGraph export' },
  { href: '/taste/rate', title: 'Quick rate', text: 'Rate books you have read' },
  {
    href: '/taste/questionnaire',
    title: 'Questionnaire',
    text: 'Optional genres, pace and themes',
  },
] as const;

/**
 * The taste profile (spec 6, D-010 point 8): rated books first, with
 * progress toward a confident match and the ways to add more, then the
 * optional questionnaire. Every change makes a new version (ONB-4).
 */
export function TasteProfilePage() {
  const taste = useTasteProfile();
  const { profile } = taste;

  return (
    <section aria-labelledby="taste-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-label-sm uppercase text-secondary">Personal matching</p>
        <h1
          id="taste-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Your taste profile
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Your ratings are what the personal match learns from. They never change what reviewers say
          about a book.
        </p>
      </header>

      {!profile ? (
        taste.error ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>{errorMessage(taste.error)}</Alert>
            <Button variant="secondary" onClick={taste.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-body-md text-on-surface-variant">
            Loading your taste profile…
          </p>
        )
      ) : (
        <>
          <div className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
            <TasteProgress profile={profile} />
            <p className="text-body-sm text-on-surface-variant">
              {profile.version === 0
                ? 'Nothing saved yet.'
                : `Version ${profile.version}${profile.createdAt ? `, saved ${formatDateTime(profile.createdAt)}` : ''}. Results made with an earlier version are marked outdated and can be recalculated.`}
            </p>
          </div>

          <nav aria-label="Add to your taste profile">
            <ul className="grid gap-3 sm:grid-cols-3">
              {ACTIONS.map((action) => (
                <li key={action.href}>
                  <Link
                    href={action.href}
                    className="flex h-full flex-col gap-1 rounded-md border border-outline-variant bg-surface-container-lowest p-4 transition-colors hover:border-secondary hover:bg-surface-container-low"
                  >
                    <span className="text-label-lg text-on-surface">{action.title}</span>
                    <span className="text-body-sm text-on-surface-variant">{action.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <RatedBooks version={profile.version} onSaved={taste.saved} />

          <QuestionnaireSummary questionnaire={profile.questionnaire} />
        </>
      )}
    </section>
  );
}

/** The current version's ratings, by title, each editable in place. */
function RatedBooks({
  version,
  onSaved,
}: {
  version: number;
  onSaved: ReturnType<typeof useTasteProfile>['saved'];
}) {
  const [items, setItems] = useState<RatedBook[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloads, setReloads] = useState(0);
  const empty = version === 0;

  useEffect(() => {
    if (empty) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setError(null);
    listRatings().then(
      (page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      },
      (e: unknown) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
    // Loaded once per visit; edits below update their own rows.
  }, [empty, reloads]);

  async function more() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listRatings(nextCursor);
      setItems((current) => {
        const seen = new Set((current ?? []).map((b) => b.editionId));
        return [...(current ?? []), ...page.items.filter((b) => !seen.has(b.editionId))];
      });
      setNextCursor(page.nextCursor);
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-serif text-headline-sm text-on-surface">Books you rated</h2>
      {error ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{errorMessage(error)}</Alert>
          <Button variant="secondary" onClick={() => setReloads((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : items === null ? (
        <p role="status" className="text-body-md text-on-surface-variant">
          Loading your ratings…
        </p>
      ) : items.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">
          No rated books yet.{' '}
          <Link href="/taste/rate" className="text-secondary underline underline-offset-4">
            Rate some books you have read
          </Link>{' '}
          or{' '}
          <Link href="/taste/import" className="text-secondary underline underline-offset-4">
            import your ratings
          </Link>
          .
        </p>
      ) : (
        <>
          <ul aria-label="Your ratings" className="flex flex-col gap-2">
            {items.map((book) => (
              <RateBookRow
                key={book.editionId}
                book={book}
                rating={book.rating}
                onSaved={onSaved}
              />
            ))}
          </ul>
          {nextCursor ? (
            <div className="flex flex-col items-start gap-3">
              <Button variant="secondary" busy={loadingMore} onClick={() => void more()}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </Button>
              {moreError ? <Alert>{errorMessage(moreError)}</Alert> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

const PACE_NAMES = { slow: 'Slow and immersive', moderate: 'Moderate', fast: 'Fast and gripping' };
const SENSITIVITY_NAMES = { high: 'avoid strongly', moderate: 'somewhat', low: 'a little' };

/** The optional answers as saved; unanswered ones are said to be unknown (ONB-3). */
function QuestionnaireSummary({
  questionnaire: q,
}: {
  questionnaire: TasteProfile['questionnaire'];
}) {
  const unknown = 'Not answered (unknown, does not affect your match)';
  const rows: Array<[string, string]> = [
    ['Genres you enjoy', q.likedGenres?.join(', ') ?? unknown],
    ['Genres you avoid', q.dislikedGenres?.join(', ') ?? unknown],
    ['Preferred pace', q.pace ? PACE_NAMES[q.pace] : unknown],
    [
      'Themes to avoid',
      q.themesToAvoid?.map((t) => `${t.theme} (${SENSITIVITY_NAMES[t.sensitivity]})`).join(', ') ??
        unknown,
    ],
  ];
  return (
    <div className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-serif text-headline-sm text-on-surface">Questionnaire (optional)</h2>
        <Link
          href="/taste/questionnaire"
          className="text-label-lg text-secondary underline underline-offset-4"
        >
          Edit answers
        </Link>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-body-md sm:grid-cols-[12rem_1fr]">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-on-surface-variant">{term}</dt>
            <dd className={value === unknown ? 'text-on-surface-variant' : 'text-on-surface'}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
