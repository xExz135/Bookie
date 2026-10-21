'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { Cover } from '@/components/analysis/parts';
import { MATCH_DISCLAIMER } from '@/components/analysis/personal-match';
import { editionLine } from '@/components/discovery/candidate-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CONFIDENCE_LABELS, formatDate, MODEL_NAMES } from '@/lib/analysis/labels';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { type HeldOutBook, type Study, getStudy, joinStudy, leaveStudy } from '@/lib/study/api';

/**
 * The user study (spec 9, FE-10, CONTRACT 4.6). The reader joins with the
 * ratings they already have; the API holds some of them out, predicts them
 * from the rest, and the screen shows each prediction next to the reader's
 * own rating and the B0 baseline. Every number is the API's: nothing is
 * computed or combined here.
 */
export function StudyScreen() {
  const [study, setStudy] = useState<Study | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getStudy().then(
      (s) => {
        if (!cancelled) {
          setStudy(s);
          setLoadError(null);
        }
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(e);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  return (
    <section aria-labelledby="study-title" className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-label-sm uppercase text-secondary">Research</p>
        <h1
          id="study-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          User study
        </h1>
        <p className="text-body-lg text-on-surface-variant">
          How well does Bookie predict your ratings? Some of the books you rated are hidden from the
          model, it predicts them from your other ratings, and you see its predictions next to your
          own ratings and a simple baseline.
        </p>
      </header>

      {study ? (
        <StudyBody study={study} onChange={setStudy} onReload={reload} />
      ) : loadError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{errorMessage(loadError)}</Alert>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-body-md text-on-surface-variant">
          Loading the study…
        </p>
      )}
    </section>
  );
}

function StudyBody({
  study,
  onChange,
  onReload,
}: {
  study: Study;
  onChange: (s: Study) => void;
  onReload: () => void;
}) {
  if (study.status === 'joined') return <Results study={study} onLeft={onReload} />;
  if (study.status === 'eligible')
    return <Join study={study} onJoined={onChange} onReload={onReload} />;
  return <NotEligible study={study} />;
}

/** What the reader still needs, from the API's counts (CONTRACT 4.6). */
function NotEligible({ study }: { study: Study }) {
  const { minRatedBooks, heldOutBooks } = study.requirements;
  let text: string;
  let rateLink = true;
  switch (study.ineligibleReason) {
    case 'too_few_ratings':
      text = `You have rated ${study.ratedCount} ${study.ratedCount === 1 ? 'book' : 'books'}. Rate at least ${minRatedBooks} books you have read to take part.`;
      break;
    case 'too_few_known_books':
      text = `${study.knownCount} of your rated books are among the books the model knows, and ${heldOutBooks} are needed to hide from it. Rating more well-known books helps.`;
      break;
    default:
      text =
        'Personal matching is not available yet, so the study cannot run. Please come back later.';
      rateLink = false;
  }
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
      <h2 className="font-serif text-headline-sm text-on-surface">Not ready to take part yet</h2>
      <p className="text-body-md text-on-surface">{text}</p>
      {rateLink ? (
        <Link
          href="/taste/rate"
          className="rounded-sm border border-outline-variant px-4 py-2 text-label-lg text-on-surface hover:bg-surface-container-low"
        >
          Rate books you have read
        </Link>
      ) : null}
    </div>
  );
}

/** The consent and the join (spec 9). Nothing is sent before the reader agrees. */
function Join({
  study,
  onJoined,
  onReload,
}: {
  study: Study;
  onJoined: (s: Study) => void;
  onReload: () => void;
}) {
  const consentId = useId();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { heldOutBooks } = study.requirements;

  async function join() {
    setBusy(true);
    setError(null);
    try {
      onJoined(await joinStudy());
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'CONFLICT') {
        // The ratings changed meanwhile: show what is needed now.
        setError('You cannot take part right now. Here is what is needed.');
        onReload();
      } else {
        setError(errorMessage(e));
      }
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
      <h2 className="font-serif text-headline-sm text-on-surface">Take part</h2>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-body-md text-on-surface">
        <li>
          {heldOutBooks} of your {study.ratedCount} rated books are picked at random among the books
          the model knows, and hidden from it.
        </li>
        <li>The model predicts how you rated each of them, from your other ratings only.</li>
        <li>
          You see each prediction next to your own rating, and next to the book&apos;s average
          rating, which the model is compared against.
        </li>
      </ol>
      <p className="text-body-sm text-on-surface-variant">
        Your ratings of the hidden books and the predictions are used, without your name or email,
        in the project&apos;s results. You can leave the study at any time, which deletes them.
      </p>
      <label htmlFor={consentId} className="flex cursor-pointer items-start gap-3 text-body-md">
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 size-4 accent-primary"
        />
        I agree to take part, and to my ratings of the hidden books and the predictions being used
        in the results without my name or email.
      </label>
      <div className="flex flex-col items-start gap-3">
        <Button disabled={!consent} busy={busy} onClick={() => void join()}>
          {busy ? 'Predicting…' : 'Join the study'}
        </Button>
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </div>
  );
}

/** Each hidden book with the reader's rating, the prediction and B0, side by side. */
function Results({ study, onLeft }: { study: Study; onLeft: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-md text-on-surface-variant">
        You joined on {formatDate(study.joinedAt!)}. These {study.heldOut.length} books were hidden
        from the model (release {study.modelVersion}); it predicted them from your other ratings.
      </p>
      <p className="rounded-sm bg-surface-container-low px-4 py-3 text-body-sm text-on-surface-variant">
        {MATCH_DISCLAIMER}
      </p>
      <ul aria-label="Hidden books" className="flex flex-col gap-3">
        {study.heldOut.map((book) => (
          <HeldOut key={book.edition.editionId} book={book} max={study.scale.max} />
        ))}
      </ul>
      <Leave onLeft={onLeft} />
    </div>
  );
}

function HeldOut({ book, max }: { book: HeldOutBook; max: number }) {
  const { edition, prediction, baseline } = book;
  return (
    <li className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-4 sm:flex-row sm:p-5">
      <div className="flex min-w-0 flex-1 gap-4">
        <Cover url={edition.coverUrl} title={edition.title} className="h-24 w-16 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-label-sm uppercase text-secondary">{editionLine(edition)}</p>
          <h2 className="font-serif text-headline-sm text-on-surface">{edition.title}</h2>
          {edition.author ? (
            <p className="font-serif text-body-md italic text-on-surface-variant">
              {edition.author}
            </p>
          ) : null}
        </div>
      </div>
      <dl className="grid shrink-0 grid-cols-3 gap-3 text-center sm:w-[26rem]">
        <Figure label="Your rating" value={`${book.yourRating} / ${max}`} />
        <Figure
          label="Predicted"
          value={`${prediction.score} / ${max}`}
          note={`${MODEL_NAMES[prediction.modelId]} (${prediction.modelId}), ${CONFIDENCE_LABELS[prediction.confidence].toLowerCase()} confidence`}
        />
        <Figure
          label="Baseline"
          value={`${baseline.score} / ${max}`}
          note={`${MODEL_NAMES.B0} (B0)`}
        />
      </dl>
    </li>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-sm bg-surface-container-low px-2 py-3">
      <dt className="text-label-sm uppercase text-on-surface-variant">{label}</dt>
      <dd className="font-serif text-headline-sm text-on-surface">{value}</dd>
      {note ? <dd className="text-body-sm text-on-surface-variant">{note}</dd> : null}
    </div>
  );
}

/** Leaving deletes the participation, so it asks once more. */
function Leave({ onLeft }: { onLeft: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      await leaveStudy();
      onLeft();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3 border-t border-outline-variant/60 pt-4">
      {asking ? (
        <>
          <p className="text-body-md text-on-surface">
            Leave the study? Your hidden books and their predictions are deleted. You can join again
            later, with a new random choice.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" busy={busy} onClick={() => void leave()}>
              {busy ? 'Leaving…' : 'Yes, leave the study'}
            </Button>
            <Button variant="link" onClick={() => setAsking(false)} disabled={busy}>
              Stay in the study
            </Button>
          </div>
        </>
      ) : (
        <Button variant="link" onClick={() => setAsking(true)}>
          Leave the study
        </Button>
      )}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
