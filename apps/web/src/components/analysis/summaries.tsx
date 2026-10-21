import type { AnalysisSummary } from '@/lib/analysis/api';
import { CONFIDENCE_LABELS, MODEL_NAMES } from '@/lib/analysis/labels';
import type { ErrorCode } from '@/lib/api/types';

/**
 * Short forms of the two separate signals (D-010), used where several
 * results are shown together: history, the reading list and compare. They
 * take the summary shapes, which full analyses also satisfy.
 */

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm text-on-surface-variant">{children}</p>;
}

export function PublicSummary({
  reception,
  clamp = true,
}: {
  reception: AnalysisSummary['publicReception'];
  /** Cut the written summary to three lines. */
  clamp?: boolean;
}) {
  if (reception.status === 'pending' || reception.status === 'running') {
    return <Muted>Still being analyzed. Open it to follow the progress.</Muted>;
  }
  if (reception.status !== 'done') {
    return (
      <Muted>
        {reception.evidenceState === 'unavailable'
          ? 'Review sources could not be reached. This does not mean there are no reviews.'
          : 'Could not be made. Open it to see why and retry.'}
      </Muted>
    );
  }
  return (
    <>
      {reception.evidenceState === 'limited' ? (
        <p className="text-label-md text-on-secondary-fixed-variant">Limited evidence</p>
      ) : null}
      {reception.summary ? (
        <p className={`font-serif text-body-md text-on-surface ${clamp ? 'line-clamp-3' : ''}`}>
          {reception.summary}
        </p>
      ) : (
        <Muted>No written summary: there were no reviews with text for this edition.</Muted>
      )}
      {reception.evidenceConfidence ? (
        <Muted>Evidence confidence: {CONFIDENCE_LABELS[reception.evidenceConfidence.level]}</Muted>
      ) : null}
    </>
  );
}

export function PersonalSummary({
  match,
  showDisclaimer = true,
}: {
  /** A full analysis also carries the error code, which says why there is no match. */
  match: AnalysisSummary['personalMatch'] & { errorCode?: ErrorCode | null };
  /** Off where the page states the disclaimer once for every score. */
  showDisclaimer?: boolean;
}) {
  switch (match.status) {
    case 'running':
      return <Muted>Still being analyzed.</Muted>;
    case 'needs_taste_data':
      return <Muted>Rate some books to see how books fit your taste.</Muted>;
    case 'below_floor':
      return <Muted>Not enough rated books yet for a personal match.</Muted>;
    case 'skipped':
      return <Muted>Not made, because the public reception did not finish.</Muted>;
    case 'failed':
      if (match.errorCode === 'MODEL_UNAVAILABLE') {
        return <Muted>Personal matching is not available yet.</Muted>;
      }
      // The summary carries no error code: the full result says why.
      return <Muted>No personal match in this result. Open it for the reason.</Muted>;
    case 'done':
      return (
        <>
          <p className="flex items-baseline gap-1.5 text-on-surface">
            <span className="font-serif text-headline-md">{match.score}</span>
            <span className="text-body-md text-on-surface-variant">/ {match.scale.max}</span>
          </p>
          {showDisclaimer ? (
            <Muted>Similarity to your taste, not a probability of enjoyment.</Muted>
          ) : null}
          {match.evidenceConfidence ? (
            <Muted>Evidence confidence: {CONFIDENCE_LABELS[match.evidenceConfidence.level]}</Muted>
          ) : null}
          {match.modelId ? (
            <Muted>
              {match.isFallback ? 'Fallback model ' : 'Model '}
              {match.modelId} ({MODEL_NAMES[match.modelId]})
            </Muted>
          ) : null}
        </>
      );
  }
}
