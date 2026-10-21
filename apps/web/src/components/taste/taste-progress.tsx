import type { TasteProfile } from '@/lib/taste/api';

/**
 * How many books are rated, and what the reader gets at that number (spec 6).
 * Both thresholds come from the API, never from the browser.
 */
export function TasteProgress({
  profile,
}: {
  profile: Pick<TasteProfile, 'ratedCount' | 'hardFloor' | 'minForConfidence'>;
}) {
  const { ratedCount, hardFloor, minForConfidence } = profile;
  const what =
    ratedCount >= minForConfidence
      ? 'You have enough rated books for the most reliable personal match.'
      : ratedCount >= hardFloor
        ? `You get a personal match, marked low confidence until you have rated ${minForConfidence}.`
        : `Rate at least ${hardFloor} books to see a personal match. Public reviews are shown either way.`;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-label-md uppercase text-on-surface-variant">Rated books</span>
        <span className="text-label-lg text-on-surface">
          {ratedCount} of {minForConfidence} for a confident match
        </span>
      </p>
      <div
        role="progressbar"
        aria-label="Rated books"
        aria-valuemin={0}
        aria-valuemax={minForConfidence}
        aria-valuenow={Math.min(ratedCount, minForConfidence)}
        aria-valuetext={`${ratedCount} rated books`}
        className="relative h-2 overflow-hidden rounded-full bg-surface-container-high"
      >
        <div
          className="h-full rounded-full bg-secondary transition-[width]"
          style={{ width: `${(Math.min(ratedCount, minForConfidence) / minForConfidence) * 100}%` }}
        />
        <div
          aria-hidden="true"
          className="absolute top-0 h-full w-0.5 bg-on-surface/40"
          style={{ left: `${(hardFloor / minForConfidence) * 100}%` }}
        />
      </div>
      <p className="text-body-sm text-on-surface-variant">{what}</p>
    </div>
  );
}
