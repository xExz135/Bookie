'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { type Analysis, getAnalysis, retryAnalysis, type StepName } from '@/lib/analysis/api';
import { PERSONAL_STEPS, PUBLIC_STEPS } from '@/lib/analysis/labels';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { BookHeader } from './book-header';
import { EvidenceList } from './evidence-list';
import { PersonalMatchSection } from './personal-match';
import { PublicReceptionSection, type RetryControl } from './public-reception';
import { SectionRetry } from './section-retry';
import { StatusBadge, StatusMessage } from './status-banner';
import { StepRail } from './step-rail';

type SectionKey = 'public' | 'personal' | 'other';

/**
 * Loads an analysis and polls it while it runs (CONTRACT 2, Long work):
 * again after `pollAfterMs`, stopping when the API sends null. Leaving the
 * page only stops the polling; the analysis keeps running on the server.
 */
function useAnalysis(id: string) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getAnalysis(id).then(
      (next) => {
        if (cancelled) return;
        loaded.current = true;
        setLoadError(null);
        setPollError(null);
        setAnalysis(next);
      },
      (error: unknown) => {
        if (cancelled) return;
        // Keep showing what we have; only a first load with nothing to show is an error page.
        if (loaded.current) setPollError(error);
        else setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, reloads]);

  useEffect(() => {
    if (!analysis || analysis.pollAfterMs === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getAnalysis(id).then(
        (next) => {
          if (cancelled) return;
          setPollError(null);
          setAnalysis(next);
        },
        (error: unknown) => {
          if (!cancelled) setPollError(error);
        },
      );
    }, analysis.pollAfterMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, analysis]);

  return {
    analysis,
    setAnalysis,
    loadError,
    pollError,
    reload: () => setReloads((n) => n + 1),
  };
}

/**
 * The result screen (spec 6, FE-5): progress of the eight steps, then the
 * book, the public reception and the personal match as separate sections
 * (D-010), and the evidence they cite. Everything shown is what the API
 * returned; the screen only picks the wording for each state.
 */
export function AnalysisScreen({ id }: { id: string }) {
  const { analysis, setAnalysis, loadError, pollError, reload } = useAnalysis(id);
  const [retrying, setRetrying] = useState<SectionKey | null>(null);
  const [retryError, setRetryError] = useState<{ section: SectionKey; message: string } | null>(
    null,
  );

  const evidence = useMemo(
    () => new Map((analysis?.publicReception.evidence ?? []).map((item) => [item.id, item])),
    [analysis],
  );

  if (!analysis) {
    if (loadError) return <LoadError error={loadError} onRetry={reload} />;
    return (
      <p role="status" className="text-body-md text-on-surface-variant">
        Loading the analysis…
      </p>
    );
  }

  const failed = analysis.steps.filter((step) => step.status === 'failed');
  const failedIn = (names: readonly StepName[]) => failed.filter((s) => names.includes(s.name));
  const publicFailed = failedIn(PUBLIC_STEPS);
  const personalFailed = failedIn(PERSONAL_STEPS);
  const otherFailed = failed.filter(
    (s) => !PUBLIC_STEPS.includes(s.name) && !PERSONAL_STEPS.includes(s.name),
  );

  async function retry(section: SectionKey, steps: StepName[] | undefined) {
    setRetrying(section);
    setRetryError(null);
    try {
      setAnalysis(await retryAnalysis(id, steps));
    } catch (error) {
      setRetryError({ section, message: errorMessage(error) });
      // The analysis changed under us (already running, or nothing left to retry): show it as it is.
      if (error instanceof ApiRequestError && error.code === 'CONFLICT') reload();
    } finally {
      setRetrying(null);
    }
  }

  const control = (section: SectionKey, steps: StepName[] | undefined): RetryControl => ({
    available: analysis.canRetry && (retrying === null || retrying === section),
    busy: retrying === section,
    error: retryError?.section === section ? retryError.message : null,
    onRetry: () => void retry(section, steps),
  });

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Analysis progress"
        className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-label-md uppercase text-on-surface">Analysis progress</p>
          <StatusBadge status={analysis.status} />
        </div>
        <div aria-live="polite">
          <StatusMessage analysis={analysis} />
        </div>
        <StepRail steps={analysis.steps} />
        {pollError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>
              We could not check on this analysis just now. {errorMessage(pollError)} It keeps
              running on our side.
            </Alert>
            <Button variant="secondary" onClick={reload}>
              Check again
            </Button>
          </div>
        ) : null}
        {otherFailed.length > 0 && analysis.canRetry ? (
          <SectionRetry
            label="Retry"
            busy={retrying === 'other'}
            error={retryError?.section === 'other' ? retryError.message : null}
            onRetry={() => void retry('other', undefined)}
          />
        ) : null}
      </section>

      <BookHeader edition={analysis.edition} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PublicReceptionSection
          reception={analysis.publicReception}
          failedSteps={publicFailed}
          evidence={evidence}
          retry={control(
            'public',
            publicFailed.map((s) => s.name),
          )}
        />
        <PersonalMatchSection
          match={analysis.personalMatch}
          failedStep={personalFailed[0]}
          evidence={evidence}
          retry={control(
            'personal',
            personalFailed.map((s) => s.name),
          )}
        />
      </div>

      {analysis.publicReception.evidence.length > 0 ? (
        <EvidenceList
          evidence={analysis.publicReception.evidence}
          sources={analysis.publicReception.sources}
        />
      ) : null}
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
    return (
      <section className="flex max-w-2xl flex-col gap-3">
        <h1 className="font-serif text-headline-lg-mobile text-on-surface">
          We could not find this analysis
        </h1>
        <p className="text-body-lg text-on-surface-variant">
          The link may be wrong, or the analysis belongs to another account.
        </p>
        <Link href="/" className="text-label-lg text-secondary underline underline-offset-4">
          Find a book
        </Link>
      </section>
    );
  }
  return (
    <section className="flex max-w-2xl flex-col items-start gap-3">
      <h1 className="font-serif text-headline-lg-mobile text-on-surface">
        The analysis could not be loaded
      </h1>
      <Alert>{errorMessage(error)}</Alert>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}
