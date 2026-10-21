import { Alert } from '@/components/ui/alert';
import type { Evidence, PublicReception as Reception, Step } from '@/lib/analysis/api';
import {
  formatCount,
  formatDate,
  SOURCE_OUTCOME_LABELS,
  TRAIT_LABELS,
} from '@/lib/analysis/labels';
import { codeMessage } from '@/lib/api/errors';
import { Citations, ConfidenceBlock, Section, SubHeading } from './parts';
import { SectionRetry } from './section-retry';

export interface RetryControl {
  /** Shown only when the API says a retry will run (`canRetry`). */
  available: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}

/**
 * What reviewers say (spec 6): the written summary, praises and complaints
 * with citations, traits, the rating of each source, and the public evidence
 * confidence. One of the three separate signals (D-010).
 */
export function PublicReceptionSection({
  reception,
  failedSteps,
  evidence,
  retry,
}: {
  reception: Reception;
  failedSteps: Step[];
  evidence: ReadonlyMap<string, Evidence>;
  retry: RetryControl;
}) {
  return (
    <Section id="public" eyebrow="What reviewers say" title="Public reception">
      <PublicBody reception={reception} failedSteps={failedSteps} evidence={evidence} />
      {failedSteps.length > 0 && retry.available ? (
        <SectionRetry
          label="Retry public reception"
          busy={retry.busy}
          error={retry.error}
          onRetry={retry.onRetry}
        />
      ) : null}
      {reception.sources.length > 0 ? <SourceList sources={reception.sources} /> : null}
    </Section>
  );
}

function PublicBody({
  reception,
  failedSteps,
  evidence,
}: {
  reception: Reception;
  failedSteps: Step[];
  evidence: ReadonlyMap<string, Evidence>;
}) {
  if (reception.status === 'pending' || reception.status === 'running') {
    return (
      <p role="status" className="text-body-md text-on-surface-variant">
        Gathering reviews and ratings for this edition…
      </p>
    );
  }
  if (reception.status === 'failed' || reception.status === 'skipped') {
    const codes = [...new Set(failedSteps.map((s) => s.errorCode).filter((c) => c !== null))];
    return (
      <Alert>
        The public reception could not be made.
        {codes.map((code) => ` ${codeMessage(code)}`).join('')}
      </Alert>
    );
  }

  return (
    <>
      <EvidenceStateNote state={reception.evidenceState} />
      {reception.evidenceConfidence ? (
        <ConfidenceBlock
          label="Evidence confidence (reviews)"
          confidence={reception.evidenceConfidence}
        />
      ) : null}
      {reception.summary ? (
        <div className="flex flex-col gap-2">
          <SubHeading>Summary of reviews</SubHeading>
          <p className="whitespace-pre-line font-serif text-body-lg text-on-surface">
            {reception.summary}
          </p>
        </div>
      ) : null}
      <ClaimList title="What readers liked" claims={reception.praises} evidence={evidence} />
      <ClaimList title="Common complaints" claims={reception.complaints} evidence={evidence} />
      <BookTraits traits={reception.traits} evidence={evidence} />
    </>
  );
}

/**
 * The book's traits with the evidence for each. Traits with no values are
 * unknown (CONTRACT 4.4) and are named together on one line.
 */
function BookTraits({
  traits,
  evidence,
}: {
  traits: Reception['traits'];
  evidence: ReadonlyMap<string, Evidence>;
}) {
  if (traits.length === 0) return null;
  const known = traits.filter((t) => t.values.length > 0);
  const unknown = traits.filter((t) => t.values.length === 0).map((t) => TRAIT_LABELS[t.trait]);
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>How reviewers describe it</SubHeading>
      {known.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-2 text-body-md sm:grid-cols-[10rem_1fr]">
          {known.map((trait) => (
            <div key={trait.trait} className="contents">
              <dt className="text-on-surface-variant">{TRAIT_LABELS[trait.trait]}</dt>
              <dd className="mb-2 flex flex-col items-start gap-1.5 text-on-surface sm:mb-0">
                {trait.values.join(', ')}
                <Citations ids={trait.evidenceIds} evidence={evidence} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {unknown.length > 0 ? (
        <p className="text-body-sm text-on-surface-variant">
          Not known for this book: {unknown.join(', ').toLowerCase()}.
        </p>
      ) : null}
    </div>
  );
}

/** Limited and insufficient evidence are said plainly (spec 8 table). */
function EvidenceStateNote({ state }: { state: Reception['evidenceState'] }) {
  if (state === 'limited') {
    return (
      <Alert tone="info">
        <strong>Limited evidence.</strong> There are few reviews for this edition, or a source could
        not be reached. Read this summary with that in mind.
      </Alert>
    );
  }
  if (state === 'insufficient') {
    return (
      <Alert tone="info">
        <strong>No written summary.</strong> We found no reviews with text for this edition, so no
        summary was written. Written reviews come from a dataset that ends around 2017, so newer
        books often have ratings but no summary. The ratings each source reported are below.
      </Alert>
    );
  }
  return null;
}

function ClaimList({
  title,
  claims,
  evidence,
}: {
  title: string;
  claims: Reception['praises'];
  evidence: ReadonlyMap<string, Evidence>;
}) {
  if (claims.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>{title}</SubHeading>
      <ul className="flex flex-col gap-2">
        {claims.map((claim) => (
          <li
            key={claim.text}
            className="flex flex-col gap-1.5 rounded-sm border border-outline-variant/60 bg-surface-container-low px-4 py-3"
          >
            <span className="text-body-md text-on-surface">{claim.text}</span>
            <Citations ids={claim.evidenceIds} evidence={evidence} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Every source asked, with its outcome, so failures are disclosed (spec 11).
 * Each rating stays with its source: there is no combined score (D-010 point 3).
 */
function SourceList({ sources }: { sources: Reception['sources'] }) {
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>Sources</SubHeading>
      <ul className="flex flex-col divide-y divide-outline-variant/60 rounded-sm border border-outline-variant/60">
        {sources.map((source) => (
          <li key={source.key} className="flex flex-col gap-1 px-4 py-3">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-label-lg text-on-surface">{source.name}</span>
              <span
                className={`text-body-sm ${
                  source.outcome === 'failed' || source.outcome === 'rate_limited'
                    ? 'text-on-error-container'
                    : 'text-on-surface-variant'
                }`}
              >
                {SOURCE_OUTCOME_LABELS[source.outcome]}
              </span>
            </p>
            {source.ratingAverage !== null ? (
              <p className="text-body-md text-on-surface">
                <span className="font-medium">{source.ratingAverage} / 5</span>
                {source.ratingCount !== null
                  ? ` from ${formatCount(source.ratingCount)} ${source.ratingCount === 1 ? 'rating' : 'ratings'}`
                  : ''}
                {source.ratingScope ? (
                  <span className="text-on-surface-variant">
                    {' '}
                    · {source.ratingScope === 'work' ? 'all editions' : 'this edition'}
                  </span>
                ) : null}
              </p>
            ) : null}
            <p className="text-body-sm text-on-surface-variant">
              {source.providesText
                ? `${formatCount(source.reviewsUsed)} ${source.reviewsUsed === 1 ? 'review' : 'reviews'} with text used`
                : 'Ratings only, no review text'}
              {source.fetchedAt ? ` · checked ${formatDate(source.fetchedAt)}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
