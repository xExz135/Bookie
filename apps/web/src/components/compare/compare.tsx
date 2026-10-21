'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { editionLine } from '@/components/discovery/candidate-card';
import { Cover } from '@/components/analysis/parts';
import { MATCH_DISCLAIMER } from '@/components/analysis/personal-match';
import { StatusBadge } from '@/components/analysis/status-banner';
import { PersonalSummary, PublicSummary } from '@/components/analysis/summaries';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Analysis } from '@/lib/analysis/api';
import { formatDateTime, TRAIT_LABELS } from '@/lib/analysis/labels';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { type Comparison, compareAnalyses } from '@/lib/reading-list/api';

/**
 * Two analyzed books side by side for the same reader (spec 6, FE-8): the
 * public reception and the personal match of each, kept as separate signals
 * (D-010), and the traits that differ as the API lists them.
 */
export function Compare({ a, b }: { a: string | null; b: string | null }) {
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!a || !b) return;
    let cancelled = false;
    setError(null);
    compareAnalyses(a, b).then(
      (next) => {
        if (!cancelled) setResult(next);
      },
      (e: unknown) => {
        if (!cancelled) setError(e);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [a, b, reloads]);

  return (
    <section aria-labelledby="compare-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-label-sm uppercase text-secondary">Side by side</p>
        <h1
          id="compare-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Compare two books
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Each book keeps its own public reception and personal match. They are not combined into
          one verdict.
        </p>
      </header>
      {!a || !b ? (
        <Problem>Choose two analyzed books on your reading list to compare them.</Problem>
      ) : result ? (
        <Sides result={result} />
      ) : error ? (
        <LoadProblem error={error} onRetry={() => setReloads((n) => n + 1)} />
      ) : (
        <p role="status" className="text-body-md text-on-surface-variant">
          Loading the comparison…
        </p>
      )}
    </section>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-6">
      <p className="text-body-md text-on-surface">{children}</p>
      <Link
        href="/reading-list"
        className="text-label-lg text-secondary underline underline-offset-4"
      >
        Open the reading list
      </Link>
    </div>
  );
}

function LoadProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
    return (
      <Problem>
        One of these results could not be found. The link may be wrong, or the result belongs to
        another account.
      </Problem>
    );
  }
  if (error instanceof ApiRequestError && error.code === 'VALIDATION_FAILED') {
    return <Problem>Choose two different analyzed books to compare.</Problem>;
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert>{errorMessage(error)}</Alert>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** One row of the comparison: the same signal for each book, never merged. */
function Row({
  title,
  analyses,
  render,
}: {
  title: string;
  analyses: [Analysis, Analysis];
  render: (analysis: Analysis) => React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6"
    >
      <h2 className="font-serif text-headline-sm text-on-surface">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {analyses.map((analysis, i) => (
          <div
            key={i}
            className="flex min-w-0 flex-col gap-2 rounded-sm bg-surface-container-low p-4"
          >
            <h3 className="text-label-md uppercase text-on-surface-variant">
              {analysis.edition.title}
            </h3>
            {render(analysis)}
          </div>
        ))}
      </div>
    </section>
  );
}

function Sides({ result }: { result: Comparison }) {
  const analyses: [Analysis, Analysis] = [result.a, result.b];
  const anyScore = analyses.some((x) => x.personalMatch.status === 'done');
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {analyses.map((analysis) => (
          <BookCard key={analysis.id} analysis={analysis} />
        ))}
      </div>

      <Row
        title="Public reception"
        analyses={analyses}
        render={(x) => <PublicSummary reception={x.publicReception} clamp={false} />}
      />

      <Row
        title="Your personal match"
        analyses={analyses}
        render={(x) => <PersonalSummary match={x.personalMatch} showDisclaimer={false} />}
      />
      {anyScore ? <p className="text-body-sm text-on-surface-variant">{MATCH_DISCLAIMER}</p> : null}

      <TraitDifferences result={result} />
    </>
  );
}

function BookCard({ analysis }: { analysis: Analysis }) {
  const { edition } = analysis;
  const href = `/analyses/${analysis.id}`;
  return (
    <article className="flex gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
      <Cover url={edition.coverUrl} title={edition.title} className="h-28 w-20 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-label-sm uppercase text-secondary">{editionLine(edition)}</p>
        <h2 className="font-serif text-headline-sm text-on-surface">
          <Link href={href} className="hover:underline hover:underline-offset-4">
            {edition.title}
          </Link>
        </h2>
        {edition.author ? (
          <p className="font-serif text-body-md italic text-on-surface-variant">{edition.author}</p>
        ) : null}
        <p className="text-body-sm text-on-surface-variant">
          Analyzed {formatDateTime(analysis.createdAt)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <StatusBadge status={analysis.status} />
          <Link href={href} className="text-label-md text-secondary underline underline-offset-4">
            Open the result<span className="sr-only"> for {edition.title}</span>
          </Link>
        </div>
      </div>
    </article>
  );
}

/** The traits that differ, as the API lists them; an empty side is unknown. */
function TraitDifferences({ result }: { result: Comparison }) {
  const differences = result.traitDifferences;
  return (
    <section
      aria-labelledby="differences-title"
      className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6"
    >
      <h2 id="differences-title" className="font-serif text-headline-sm text-on-surface">
        Main differences in traits
      </h2>
      {differences.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">
          No differences: where reviews describe these traits, the two books match.
        </p>
      ) : (
        <>
          <p className="text-body-sm text-on-surface-variant">
            From what reviewers say about each book. Traits that are the same are left out.
          </p>
          <table className="w-full table-fixed border-collapse text-left text-body-md">
            <thead>
              <tr className="border-b border-outline-variant text-label-md uppercase text-on-surface-variant">
                <th scope="col" className="w-1/4 py-2 pr-3 font-normal">
                  Trait
                </th>
                <th scope="col" className="py-2 pr-3 font-normal">
                  {result.a.edition.title}
                </th>
                <th scope="col" className="py-2 font-normal">
                  {result.b.edition.title}
                </th>
              </tr>
            </thead>
            <tbody>
              {differences.map((d) => (
                <tr key={d.trait} className="border-b border-outline-variant/60 align-top">
                  <th scope="row" className="py-2 pr-3 font-normal text-on-surface-variant">
                    {TRAIT_LABELS[d.trait]}
                  </th>
                  <td className="break-words py-2 pr-3 text-on-surface">
                    <Values values={d.a} />
                  </td>
                  <td className="break-words py-2 text-on-surface">
                    <Values values={d.b} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Values({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="text-on-surface-variant">Unknown</span>;
  return <>{values.join(', ')}</>;
}
