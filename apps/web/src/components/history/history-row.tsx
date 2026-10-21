import Link from 'next/link';
import { editionLine } from '@/components/discovery/candidate-card';
import { Cover } from '@/components/analysis/parts';
import { OutdatedNotice } from '@/components/analysis/recalculate';
import { StatusBadge } from '@/components/analysis/status-banner';
import { PersonalSummary, PublicSummary } from '@/components/analysis/summaries';
import type { AnalysisSummary } from '@/lib/analysis/api';
import { formatDateTime } from '@/lib/analysis/labels';

/**
 * One analysis in the history: the book, when it was made, and the public
 * reception and personal match side by side as separate signals (D-010).
 * Opening it shows the result as it was generated.
 */
export function HistoryRow({
  item,
  recalculating,
  recalculateError,
  onRecalculate,
}: {
  item: AnalysisSummary;
  recalculating: boolean;
  recalculateError: string | null;
  onRecalculate: () => void;
}) {
  const href = `/analyses/${item.id}`;
  const match = item.personalMatch;
  return (
    <li className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
      {match.isOutdated ? (
        <OutdatedNotice
          usedVersion={match.tasteProfileVersion}
          currentVersion={match.currentTasteProfileVersion}
          busy={recalculating}
          error={recalculateError}
          onRecalculate={onRecalculate}
        />
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex gap-4">
          <Cover
            url={item.edition.coverUrl}
            title={item.edition.title}
            className="h-28 w-20 shrink-0"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-label-sm uppercase text-secondary">{editionLine(item.edition)}</p>
            <h2 className="font-serif text-headline-sm text-on-surface">
              <Link href={href} className="hover:underline hover:underline-offset-4">
                {item.edition.title}
              </Link>
            </h2>
            {item.edition.author ? (
              <p className="font-serif text-body-md italic text-on-surface-variant">
                {item.edition.author}
              </p>
            ) : null}
            <p className="text-body-sm text-on-surface-variant">
              Analyzed {formatDateTime(item.createdAt)}
            </p>
            <div className="mt-1">
              <StatusBadge status={item.status} />
            </div>
          </div>
        </div>

        <Column title="Public reception">
          <PublicSummary reception={item.publicReception} />
        </Column>

        <Column title="Your personal match">
          <PersonalSummary match={match} />
        </Column>
      </div>
      <Link
        href={href}
        className="self-start text-label-lg text-secondary underline underline-offset-4 hover:text-on-secondary-fixed-variant"
      >
        Open the full result<span className="sr-only"> for {item.edition.title}</span>
      </Link>
    </li>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-sm bg-surface-container-low p-4">
      <h3 className="text-label-md uppercase text-on-surface-variant">{title}</h3>
      {children}
    </div>
  );
}
