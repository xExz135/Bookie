import type { Analysis } from '@/lib/analysis/api';
import { STEP_LABELS, STEP_STATUS_LABELS } from '@/lib/analysis/labels';
import { codeMessage } from '@/lib/api/errors';

const STATUS_STYLES: Record<Analysis['steps'][number]['status'], string> = {
  pending: 'border-outline-variant/70 bg-surface-container-lowest text-on-surface-variant',
  running: 'border-secondary bg-secondary-fixed/40 text-on-surface',
  done: 'border-on-tertiary-container/40 bg-surface-container-low text-on-surface',
  failed: 'border-error/40 bg-error-container text-on-error-container',
  skipped: 'border-outline-variant/70 bg-surface-container text-on-surface-variant',
};

const STATUS_MARKS: Record<Analysis['steps'][number]['status'], string> = {
  pending: '○',
  running: '◐',
  done: '✓',
  failed: '!',
  skipped: '–',
};

/**
 * The eight steps, each with its own status (RES-2, D-010 point 7), in the
 * order the API lists them. A failed step says why.
 */
export function StepRail({ steps }: { steps: Analysis['steps'] }) {
  return (
    <ol
      aria-label="Analysis steps"
      className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
    >
      {steps.map((step, index) => (
        <li
          key={step.name}
          className={`flex min-w-0 flex-col gap-1 rounded-sm border px-3 py-2 ${STATUS_STYLES[step.status]}`}
        >
          <span className="text-label-sm uppercase opacity-80">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="text-label-lg">{STEP_LABELS[step.name]}</span>
          <span className="flex items-center gap-1 text-body-sm">
            <span aria-hidden="true">{STATUS_MARKS[step.status]}</span>
            {STEP_STATUS_LABELS[step.status]}
            {step.status === 'running' ? <span className="sr-only"> (current step)</span> : null}
          </span>
          {step.status === 'failed' && step.errorCode ? (
            <span className="text-body-sm">{codeMessage(step.errorCode)}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
