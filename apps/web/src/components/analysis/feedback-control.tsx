'use client';

import { useState } from 'react';
import { type FeedbackTarget, type FeedbackValue, saveFeedback } from '@/lib/analysis/api';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';

const CHOICES: Array<{ value: FeedbackValue; label: string }> = [
  { value: 'accurate', label: 'Accurate' },
  { value: 'not_for_me', label: 'Not for me' },
];

const QUESTIONS: Record<FeedbackTarget, string> = {
  public: 'Does this summary of reviews seem accurate to you?',
  personal: 'Does this personal match feel right?',
};

/**
 * Accurate / Not for me for one section (spec 6, D-010 point 9, FB-1). Each
 * section has its own; the choice can be changed and is saved at once. The
 * caller shows it only on a section that was generated.
 */
export function FeedbackControl({
  analysisId,
  target,
  initial,
}: {
  analysisId: string;
  target: FeedbackTarget;
  initial: FeedbackValue | null;
}) {
  const [value, setValue] = useState<FeedbackValue | null>(initial);
  const [saving, setSaving] = useState<FeedbackValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function choose(next: FeedbackValue) {
    if (next === value || saving) return;
    const before = value;
    setValue(next);
    setSaving(next);
    setError(null);
    setJustSaved(false);
    try {
      const saved = await saveFeedback(analysisId, target, next);
      setValue(saved.value);
      setJustSaved(true);
    } catch (e) {
      setValue(before);
      setError(
        e instanceof ApiRequestError && e.code === 'CONFLICT'
          ? 'This section can no longer be rated.'
          : errorMessage(e),
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-outline-variant/60 pt-4">
      <div
        role="group"
        aria-label={QUESTIONS[target]}
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <p className="text-body-sm text-on-surface-variant">{QUESTIONS[target]}</p>
        <div className="flex gap-2">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={value === choice.value}
              disabled={saving !== null}
              onClick={() => void choose(choice.value)}
              className="rounded-sm border border-outline-variant px-3 py-1.5 text-label-md text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-wait aria-pressed:border-secondary aria-pressed:bg-secondary-fixed/40 aria-pressed:text-on-secondary-fixed"
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <p aria-live="polite" className="text-body-sm text-on-surface-variant">
        {saving ? 'Saving…' : justSaved ? 'Saved. You can change it any time.' : ''}
      </p>
      {error ? (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
