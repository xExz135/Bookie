'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { editionLine } from '@/components/discovery/candidate-card';
import { Cover } from '@/components/analysis/parts';
import { MATCH_DISCLAIMER } from '@/components/analysis/personal-match';
import { PersonalSummary } from '@/components/analysis/summaries';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/analysis/labels';
import { errorMessage } from '@/lib/api/errors';
import { startAnalysis } from '@/lib/discovery/api';
import {
  getReadingList,
  type ReadingListGroup,
  type ReadingListItem,
  removeFromReadingList,
} from '@/lib/reading-list/api';

/** How each group is introduced (LIST-2): only `ranked` items are ranked. */
const GROUPS: Record<ReadingListGroup, { title: string; note: string; label: string | null }> = {
  ranked: {
    title: 'Ranked by your match',
    note: 'Highest match first. Only matches with medium or high confidence are ranked.',
    label: null,
  },
  low_confidence: {
    title: 'Low confidence',
    note: 'These have a match, but too little evidence to rank them with the others. Newest added first.',
    label: 'Low confidence, not ranked',
  },
  no_match: {
    title: 'No personal match',
    note: 'Not analyzed yet, or no match could be made. Newest added first.',
    label: 'No personal match',
  },
};

/**
 * Splits the list into its groups, keeping the API's order inside each
 * (CONTRACT 4.5: the list comes in the order to show; never re-sort).
 */
function grouped(items: ReadingListItem[]) {
  const groups: Array<{ group: ReadingListGroup; items: ReadingListItem[] }> = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.group === item.group) last.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}

/**
 * The reading list (spec 6, FE-8): saved books ranked by their stored
 * personal match (LIST-1), with low-confidence and unmatched books labeled
 * in their own groups (LIST-2). Two analyzed books can be compared.
 */
export function ReadingList() {
  const [items, setItems] = useState<ReadingListItem[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    getReadingList().then(
      (list) => {
        if (!cancelled) setItems(list.items);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  function removed(editionId: string) {
    const item = items?.find((i) => i.edition.editionId === editionId);
    setItems((current) => (current ?? []).filter((i) => i.edition.editionId !== editionId));
    if (item?.analysisId) setSelected((s) => s.filter((id) => id !== item.analysisId));
  }

  function toggle(analysisId: string) {
    setSelected((s) =>
      s.includes(analysisId)
        ? s.filter((id) => id !== analysisId)
        : s.length < 2
          ? [...s, analysisId]
          : s,
    );
  }

  const hasScore = items?.some((i) => i.personalMatch?.status === 'done') ?? false;

  return (
    <section aria-labelledby="reading-list-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-label-sm uppercase text-secondary">Saved for later</p>
        <h1
          id="reading-list-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Reading list
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Ordered by the personal match stored with each book&rsquo;s latest result. The order
          changes only when a new result is made, not when you rate more books.
        </p>
      </header>

      {items === null ? (
        loadError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>{errorMessage(loadError)}</Alert>
            <Button variant="secondary" onClick={() => setReloads((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-body-md text-on-surface-variant">
            Loading your reading list…
          </p>
        )
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-6">
          <p className="font-serif text-headline-sm text-on-surface">Your reading list is empty</p>
          <p className="text-body-md text-on-surface-variant">
            Find a book, and save it from its result with &ldquo;Save to reading list&rdquo;.
          </p>
          <Link href="/" className="text-label-lg text-secondary underline underline-offset-4">
            Find a book
          </Link>
        </div>
      ) : (
        <>
          <CompareBar items={items} selected={selected} onClear={() => setSelected([])} />
          {hasScore ? (
            <p className="text-body-sm text-on-surface-variant">{MATCH_DISCLAIMER}</p>
          ) : null}
          {grouped(items).map(({ group, items: groupItems }) => (
            <section key={group} aria-labelledby={`group-${group}`} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h2 id={`group-${group}`} className="font-serif text-headline-sm text-on-surface">
                  {GROUPS[group].title}
                </h2>
                <p className="text-body-sm text-on-surface-variant">{GROUPS[group].note}</p>
              </div>
              <ol aria-label={GROUPS[group].title} className="flex flex-col gap-3">
                {groupItems.map((item, index) => (
                  <ReadingListRow
                    key={item.edition.editionId}
                    item={item}
                    rank={group === 'ranked' ? index + 1 : null}
                    selected={item.analysisId !== null && selected.includes(item.analysisId)}
                    canSelect={selected.length < 2}
                    onToggle={() => item.analysisId && toggle(item.analysisId)}
                    onRemoved={() => removed(item.edition.editionId)}
                  />
                ))}
              </ol>
            </section>
          ))}
        </>
      )}
    </section>
  );
}

/** Pick two analyzed books, then open them side by side. */
function CompareBar({
  items,
  selected,
  onClear,
}: {
  items: ReadingListItem[];
  selected: string[];
  onClear: () => void;
}) {
  const analyzed = items.filter((i) => i.analysisId !== null).length;
  if (analyzed < 2) return null;
  const titles = selected.map(
    (id) => items.find((i) => i.analysisId === id)?.edition.title ?? 'a book',
  );
  return (
    <div
      role="region"
      aria-label="Compare two books"
      className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-low p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <p aria-live="polite" className="text-body-md text-on-surface">
        {selected.length === 0
          ? 'To compare two analyzed books side by side, tick Compare on each.'
          : selected.length === 1
            ? `${titles[0]} chosen. Tick one more to compare.`
            : `${titles[0]} and ${titles[1]} chosen.`}
      </p>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {selected.length > 0 ? (
          <Button variant="link" onClick={onClear}>
            Clear
          </Button>
        ) : null}
        {selected.length === 2 ? (
          <Link
            href={`/compare?a=${selected[0]}&b=${selected[1]}`}
            className="inline-flex items-center justify-center rounded-sm bg-primary px-5 py-3 text-label-lg text-on-primary transition-colors hover:bg-primary-container"
          >
            Compare the two
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function ReadingListRow({
  item,
  rank,
  selected,
  canSelect,
  onToggle,
  onRemoved,
}: {
  item: ReadingListItem;
  rank: number | null;
  selected: boolean;
  /** False once two other books are chosen. */
  canSelect: boolean;
  onToggle: () => void;
  onRemoved: () => void;
}) {
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { edition, analysisId, personalMatch } = item;
  const label = GROUPS[item.group].label;

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      await removeFromReadingList(edition.editionId);
      onRemoved();
    } catch (e) {
      setError(errorMessage(e));
      setRemoving(false);
    }
  }

  async function analyze() {
    setStarting(true);
    setError(null);
    try {
      const analysis = await startAnalysis(edition.editionId);
      router.push(`/analyses/${analysis.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setStarting(false);
    }
  }

  return (
    <li className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:flex-row sm:p-6">
      <div className="flex min-w-0 flex-1 gap-4">
        {rank !== null ? (
          <p className="w-6 shrink-0 font-serif text-headline-sm text-on-surface-variant">
            <span className="sr-only">Rank </span>
            {rank}
          </p>
        ) : null}
        <Cover url={edition.coverUrl} title={edition.title} className="h-24 w-16 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-label-sm uppercase text-secondary">{editionLine(edition)}</p>
          <h3 className="font-serif text-headline-sm text-on-surface">
            {analysisId ? (
              <Link
                href={`/analyses/${analysisId}`}
                className="hover:underline hover:underline-offset-4"
              >
                {edition.title}
              </Link>
            ) : (
              edition.title
            )}
          </h3>
          {edition.author ? (
            <p className="font-serif text-body-md italic text-on-surface-variant">
              {edition.author}
            </p>
          ) : null}
          <p className="text-body-sm text-on-surface-variant">Added {formatDate(item.addedAt)}</p>
          {label ? (
            <p className="mt-1 self-start rounded-sm border border-outline-variant px-2 py-0.5 text-label-sm uppercase text-on-surface-variant">
              {label}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2 rounded-sm bg-surface-container-low p-4 sm:w-64 sm:shrink-0">
        <h4 className="text-label-md uppercase text-on-surface-variant">Your personal match</h4>
        {personalMatch ? (
          <>
            <PersonalSummary match={personalMatch} showDisclaimer={false} />
            {personalMatch.isOutdated ? (
              <p className="text-body-sm text-on-secondary-fixed-variant">
                Made with an earlier taste profile. Open it to recalculate.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-body-sm text-on-surface-variant">
            {analysisId ? 'No personal match in this result.' : 'Not analyzed yet.'}
          </p>
        )}
      </div>

      <div className="flex flex-col items-start gap-3 sm:w-44 sm:shrink-0">
        {analysisId ? (
          <>
            <Link
              href={`/analyses/${analysisId}`}
              className="text-label-lg text-secondary underline underline-offset-4 hover:text-on-secondary-fixed-variant"
            >
              Open the result<span className="sr-only"> for {edition.title}</span>
            </Link>
            <label className="flex cursor-pointer items-center gap-2 text-body-md text-on-surface has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
              <input
                type="checkbox"
                checked={selected}
                disabled={!selected && !canSelect}
                onChange={onToggle}
                className="size-4 accent-secondary"
              />
              Compare<span className="sr-only"> {edition.title}</span>
            </label>
          </>
        ) : (
          <Button variant="secondary" busy={starting} onClick={() => void analyze()}>
            {starting ? 'Starting…' : 'Analyze it'}
            <span className="sr-only"> {edition.title}</span>
          </Button>
        )}
        <Button variant="link" busy={removing} onClick={() => void remove()}>
          {removing ? 'Removing…' : 'Remove'}
          <span className="sr-only"> {edition.title} from the reading list</span>
        </Button>
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </li>
  );
}
