import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import type { Evidence, FeedbackValue, PersonalMatch, Step } from '@/lib/analysis/api';
import { formatDateTime, MODEL_NAMES, TRAIT_LABELS } from '@/lib/analysis/labels';
import { codeMessage } from '@/lib/api/errors';
import { FeedbackControl } from './feedback-control';
import { Citations, ConfidenceBlock, Cover, Section, SubHeading } from './parts';
import type { RetryControl } from './public-reception';
import { SectionRetry } from './section-retry';

/** Said next to every score (spec 6, D-010 point 2). */
export const MATCH_DISCLAIMER =
  'This score reflects how similar this book is to your taste, based on the books you rated. It is not a probability that you will enjoy it.';

/**
 * How this book fits the reader's taste (spec 6 and 7): the model's score on
 * the 1 to 5 scale, its own evidence confidence, the model and versions that
 * made it (MODEL-3), and the model's explanations. One of the three separate
 * signals (D-010). A failure here never hides the public reception (RES-7).
 */
export function PersonalMatchSection({
  match,
  failedStep,
  evidence,
  retry,
  feedback,
}: {
  match: PersonalMatch;
  failedStep: Step | undefined;
  evidence: ReadonlyMap<string, Evidence>;
  retry: RetryControl;
  /** Shown only when there is a score to judge (spec 6). */
  feedback: { analysisId: string; value: FeedbackValue | null };
}) {
  return (
    <Section id="personal" eyebrow="For you" title="Your personal match">
      <PersonalBody match={match} evidence={evidence} />
      {match.status === 'failed' &&
      failedStep &&
      failedStep.errorCode !== 'MODEL_UNAVAILABLE' &&
      retry.available ? (
        <SectionRetry
          label="Retry personal match"
          busy={retry.busy}
          error={retry.error}
          onRetry={retry.onRetry}
        />
      ) : null}
      {match.status === 'done' ? (
        <FeedbackControl
          analysisId={feedback.analysisId}
          target="personal"
          initial={feedback.value}
        />
      ) : null}
    </Section>
  );
}

function PersonalBody({
  match,
  evidence,
}: {
  match: PersonalMatch;
  evidence: ReadonlyMap<string, Evidence>;
}) {
  switch (match.status) {
    case 'running':
      return (
        <p role="status" className="text-body-md text-on-surface-variant">
          Matching this book to your taste…
        </p>
      );
    case 'needs_taste_data':
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-body-md text-on-surface">
            Rate some books you have read to see how this one fits your taste. You need at least{' '}
            {match.hardFloor} rated books for a personal match.
          </p>
          <RateBooksLink />
        </div>
      );
    case 'below_floor':
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-body-md text-on-surface">
            You have rated {match.ratedCount} {match.ratedCount === 1 ? 'book' : 'books'}. Rate at
            least {match.hardFloor} to see a personal match; {match.minForConfidence} or more make
            it more reliable.
          </p>
          <RateBooksLink />
        </div>
      );
    case 'skipped':
      return (
        <p className="text-body-md text-on-surface-variant">
          The personal match uses the public reception, which did not finish, so it was not made.
        </p>
      );
    case 'failed':
      if (match.errorCode === 'MODEL_UNAVAILABLE') {
        return (
          <p className="text-body-md text-on-surface">
            Personal matching is not available yet. Your {match.ratedCount} rated books are saved
            and will be used once it is. The public reception is not affected.
          </p>
        );
      }
      return (
        <Alert>
          The personal match could not be made.
          {match.errorCode ? ` ${codeMessage(match.errorCode)}` : ''} The public reception is not
          affected.
        </Alert>
      );
    case 'done':
      return <MatchResult match={match} evidence={evidence} />;
  }
}

/** The invitation to rate books (ONB-2). */
function RateBooksLink() {
  return (
    <Link
      href="/taste/rate"
      className="rounded-sm border border-outline-variant px-4 py-2 text-label-lg text-on-surface hover:bg-surface-container-low"
    >
      Rate books you have read
    </Link>
  );
}

function MatchResult({
  match,
  evidence,
}: {
  match: PersonalMatch;
  evidence: ReadonlyMap<string, Evidence>;
}) {
  const aligned = match.traits.filter((t) => t.fit === 'aligned');
  const conflicting = match.traits.filter((t) => t.fit === 'conflicting');
  const unknown = match.traits.filter((t) => t.fit === 'unknown');

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="text-label-md uppercase text-on-surface-variant">Taste match</p>
        <p className="flex items-baseline gap-2 text-on-surface">
          {/* Shown exactly as the API rounded it, never as a percentage (D-007, D-010). */}
          <span className="font-serif text-display-lg-mobile">{match.score}</span>
          <span className="text-body-lg text-on-surface-variant">/ {match.scale.max}</span>
        </p>
        <p className="rounded-sm bg-surface-container-low px-4 py-3 text-body-sm text-on-surface-variant">
          {MATCH_DISCLAIMER}
        </p>
      </div>

      {match.isFallback && match.modelId ? (
        <Alert tone="info">
          <strong>Low confidence.</strong> This score comes from a simpler fallback model,{' '}
          {match.modelId} ({MODEL_NAMES[match.modelId]}), because you have not yet rated enough
          books for the learned model.
        </Alert>
      ) : null}

      {match.evidenceConfidence ? (
        <ConfidenceBlock
          label="Evidence confidence (your ratings)"
          confidence={match.evidenceConfidence}
        />
      ) : null}

      {match.similarRatedBooks.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SubHeading>Similar books you rated</SubHeading>
          <ul className="flex flex-col gap-2">
            {match.similarRatedBooks.map((book) => (
              <li key={book.editionId} className="flex items-center gap-3">
                <Cover url={book.coverUrl} title={book.title} className="h-14 w-10 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body-md text-on-surface">{book.title}</span>
                  <span className="text-body-sm text-on-surface-variant">
                    {book.author ? `${book.author} · ` : ''}you rated it {book.yourRating} / 5
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <TraitGroup title="Why it fits" traits={aligned} evidence={evidence} />
      <TraitGroup title="Things to keep in mind" traits={conflicting} evidence={evidence} />
      {unknown.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SubHeading>Not factored in</SubHeading>
          <ul className="flex flex-col gap-2">
            {unknown.map((trait) => (
              <li
                key={`${trait.trait}-${trait.bookValues.join()}`}
                className="rounded-sm border border-outline-variant/60 px-4 py-3 text-body-sm text-on-surface-variant"
              >
                <span className="text-label-lg text-on-surface">{TRAIT_LABELS[trait.trait]}</span>
                {trait.bookValues.length > 0 ? `: ${trait.bookValues.join(', ')}. ` : '. '}
                {trait.yourValues.length === 0
                  ? 'You have no preference on record for this, so it did not affect the score.'
                  : 'This is not known for this book, so it did not affect the score.'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <MatchDetails match={match} />
    </>
  );
}

function TraitGroup({
  title,
  traits,
  evidence,
}: {
  title: string;
  traits: PersonalMatch['traits'];
  evidence: ReadonlyMap<string, Evidence>;
}) {
  if (traits.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>{title}</SubHeading>
      <ul className="flex flex-col gap-2">
        {traits.map((trait) => (
          <li
            key={`${trait.trait}-${trait.bookValues.join()}`}
            className="flex flex-col gap-1.5 rounded-sm border border-outline-variant/60 bg-surface-container-low px-4 py-3"
          >
            <span className="text-label-lg text-on-surface">{TRAIT_LABELS[trait.trait]}</span>
            <span className="text-body-sm text-on-surface-variant">
              This book: {trait.bookValues.join(', ')} · Your ratings: {trait.yourValues.join(', ')}
            </span>
            <Citations ids={trait.evidenceIds} evidence={evidence} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What produced the score (MODEL-3). */
function MatchDetails({ match }: { match: PersonalMatch }) {
  return (
    <div className="flex flex-col gap-2 border-t border-outline-variant/60 pt-4">
      <SubHeading>How this was calculated</SubHeading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
        {match.modelId ? (
          <>
            <dt className="text-on-surface-variant">Model</dt>
            <dd className="text-on-surface">
              {match.modelId} ({MODEL_NAMES[match.modelId]})
              {match.modelVersion ? `, version ${match.modelVersion}` : ''}
            </dd>
          </>
        ) : null}
        {match.tasteProfileVersion !== null ? (
          <>
            <dt className="text-on-surface-variant">Taste profile</dt>
            <dd className="text-on-surface">
              Version {match.tasteProfileVersion}
              {match.isOutdated
                ? ` (yours is now version ${match.currentTasteProfileVersion})`
                : ''}
            </dd>
          </>
        ) : null}
        {match.generatedAt ? (
          <>
            <dt className="text-on-surface-variant">Generated</dt>
            <dd className="text-on-surface">{formatDateTime(match.generatedAt)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
