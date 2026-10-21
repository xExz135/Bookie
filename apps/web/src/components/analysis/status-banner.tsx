import type { Analysis } from '@/lib/analysis/api';
import { codeMessage } from '@/lib/api/errors';

const STATUS_LABELS: Record<Analysis['status'], string> = {
  running: 'Analyzing',
  complete: 'Complete',
  partial: 'Partial result',
  failed: 'Could not finish',
};

const BADGE_STYLES: Record<Analysis['status'], string> = {
  running: 'bg-secondary-fixed text-on-secondary-fixed',
  complete: 'bg-tertiary-fixed/60 text-on-tertiary-fixed-variant',
  partial: 'bg-surface-container-high text-on-surface',
  failed: 'bg-error-container text-on-error-container',
};

/** The overall status in a word, as the API reports it. */
export function StatusBadge({ status }: { status: Analysis['status'] }) {
  return (
    <span className={`rounded-full px-3 py-1 text-label-md ${BADGE_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * One line on what the overall status means for the reader. The details of
 * each part, and its retry, are in that part's section.
 */
export function StatusMessage({ analysis }: { analysis: Analysis }) {
  if (analysis.status === 'running') {
    return (
      <p className="text-body-md text-on-surface-variant">
        Analyzing this book. You can leave this page: the analysis keeps running and its result is
        saved.
      </p>
    );
  }
  if (analysis.status === 'partial') {
    return (
      <p className="text-body-md text-on-surface-variant">
        Some parts of this result are limited or missing. Each section below says what and why.
      </p>
    );
  }
  if (analysis.status === 'failed') {
    const failed = analysis.steps.find((step) => step.status === 'failed' && step.errorCode);
    return (
      <p className="text-body-md text-on-error-container">
        This analysis could not finish.
        {failed?.errorCode ? ` ${codeMessage(failed.errorCode)}` : ''}
      </p>
    );
  }
  return null;
}
