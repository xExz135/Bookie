'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import {
  getQuestionnaireOptions,
  type QuestionnaireOptions,
  type QuestionnaireRequest,
  saveQuestionnaire,
} from '@/lib/taste/api';
import { useTasteProfile } from './use-taste';

type Pace = NonNullable<QuestionnaireRequest['pace']>;
type Sensitivity = 'high' | 'moderate' | 'low';

const PACE_LABELS: Record<Pace, string> = {
  slow: 'Slow and immersive',
  moderate: 'Moderate',
  fast: 'Fast and gripping',
};
const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  high: 'Avoid strongly',
  moderate: 'Somewhat',
  low: 'A little',
};

interface Answers {
  liked: string[];
  disliked: string[];
  pace: Pace | null;
  themes: Record<string, Sensitivity>;
}

/**
 * The optional questionnaire (D-011): every field can be left out, and what
 * is left out is sent as unknown (`null`), never as a dislike (ONB-3).
 */
export function QuestionnaireForm() {
  const taste = useTasteProfile();
  const [options, setOptions] = useState<QuestionnaireOptions | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    getQuestionnaireOptions().then(
      (opts) => !cancelled && setOptions(opts),
      (e: unknown) => !cancelled && setLoadError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  // Start from the saved answers, once; later saves keep what is on screen.
  const profile = taste.profile;
  useEffect(() => {
    if (!profile || answers) return;
    const q = profile.questionnaire;
    setAnswers({
      liked: q.likedGenres ?? [],
      disliked: q.dislikedGenres ?? [],
      pace: q.pace,
      themes: Object.fromEntries((q.themesToAvoid ?? []).map((t) => [t.theme, t.sensitivity])),
    });
  }, [profile, answers]);

  function update(change: Partial<Answers>) {
    setAnswers((a) => (a ? { ...a, ...change } : a));
    setSavedVersion(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!answers) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    const themes = Object.entries(answers.themes).map(([theme, sensitivity]) => ({
      theme,
      sensitivity,
    }));
    // Nothing chosen is unknown, so it is sent as null rather than an empty choice.
    const body: QuestionnaireRequest = {
      likedGenres: answers.liked.length > 0 ? answers.liked : null,
      dislikedGenres: answers.disliked.length > 0 ? answers.disliked : null,
      pace: answers.pace,
      themesToAvoid: themes.length > 0 ? themes : null,
    };
    try {
      const saved = await saveQuestionnaire(body);
      taste.saved(saved);
      setSavedVersion(saved.tasteProfileVersion);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'VALIDATION_FAILED') {
        setFieldErrors(e.fields);
      }
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="questionnaire-title" className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href="/taste" className="text-label-md text-secondary underline underline-offset-4">
          Your taste profile
        </Link>
        <h1
          id="questionnaire-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Questionnaire
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Optional. Answer only what you are sure about: anything you leave out stays unknown and
          never counts against a book. Your ratings matter more than these answers.
        </p>
      </header>

      {!answers || !options ? (
        loadError || taste.error ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>{errorMessage(loadError ?? taste.error)}</Alert>
            <Button
              variant="secondary"
              onClick={() => {
                setReloads((n) => n + 1);
                taste.reload();
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-body-md text-on-surface-variant">
            Loading…
          </p>
        )
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
          <GenreChoice
            legend="Genres you enjoy"
            genres={options.genres}
            chosen={answers.liked}
            unavailable={answers.disliked}
            unavailableNote="marked as disliked"
            error={fieldErrors.likedGenres}
            onChange={(liked) => update({ liked })}
          />
          <GenreChoice
            legend="Genres you avoid"
            genres={options.genres}
            chosen={answers.disliked}
            unavailable={answers.liked}
            unavailableNote="marked as enjoyed"
            error={fieldErrors.dislikedGenres}
            onChange={(disliked) => update({ disliked })}
          />

          <fieldset className="flex flex-col gap-2 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
            <legend className="px-1 text-label-md uppercase text-on-surface-variant">
              Preferred pace
            </legend>
            <div className="flex flex-wrap gap-2">
              {[...options.paces, null].map((pace) => (
                <label
                  key={pace ?? 'none'}
                  className="flex cursor-pointer items-center gap-2 rounded-sm border border-outline-variant px-3 py-2 text-body-md has-[:checked]:border-secondary has-[:checked]:bg-secondary-fixed/30"
                >
                  <input
                    type="radio"
                    name="pace"
                    checked={answers.pace === pace}
                    onChange={() => update({ pace })}
                    className="accent-secondary"
                  />
                  {pace ? PACE_LABELS[pace] : 'No preference'}
                </label>
              ))}
            </div>
            {fieldErrors.pace ? (
              <p className="text-body-sm text-error">{fieldErrors.pace}</p>
            ) : null}
          </fieldset>

          <fieldset className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
            <legend className="px-1 text-label-md uppercase text-on-surface-variant">
              Themes to avoid
            </legend>
            <p className="text-body-sm text-on-surface-variant">
              A theme left at &ldquo;No preference&rdquo; is unknown and does not affect your match.
            </p>
            {options.themes.map((theme) => (
              <div
                key={theme}
                role="radiogroup"
                aria-label={theme}
                className="flex flex-col gap-2 border-t border-outline-variant/60 pt-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-body-md text-on-surface">{theme}</span>
                <div className="flex flex-wrap gap-1.5">
                  {(['high', 'moderate', 'low', null] as const).map((level) => (
                    <label
                      key={level ?? 'none'}
                      className="flex cursor-pointer items-center gap-1.5 rounded-sm border border-outline-variant px-2.5 py-1.5 text-body-sm has-[:checked]:border-secondary has-[:checked]:bg-secondary-fixed/30"
                    >
                      <input
                        type="radio"
                        name={`theme-${theme}`}
                        checked={(answers.themes[theme] ?? null) === level}
                        onChange={() => {
                          const themes = { ...answers.themes };
                          if (level) themes[theme] = level;
                          else delete themes[theme];
                          update({ themes });
                        }}
                        className="accent-secondary"
                      />
                      {level ? SENSITIVITY_LABELS[level] : 'No preference'}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {fieldErrors.themesToAvoid ? (
              <p className="text-body-sm text-error">{fieldErrors.themesToAvoid}</p>
            ) : null}
          </fieldset>

          <div className="flex flex-col items-start gap-3">
            <Button type="submit" busy={saving}>
              {saving ? 'Saving…' : 'Save answers'}
            </Button>
            {savedVersion !== null ? (
              <Alert tone="success">
                Saved as taste profile version {savedVersion}.{' '}
                <Link href="/taste" className="underline underline-offset-4">
                  Back to your taste profile
                </Link>
              </Alert>
            ) : null}
            {error ? <Alert>{error}</Alert> : null}
          </div>
        </form>
      )}
    </section>
  );
}

function GenreChoice({
  legend,
  genres,
  chosen,
  unavailable,
  unavailableNote,
  error,
  onChange,
}: {
  legend: string;
  genres: string[];
  chosen: string[];
  unavailable: string[];
  unavailableNote: string;
  error: string | undefined;
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
      <legend className="px-1 text-label-md uppercase text-on-surface-variant">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {genres.map((genre) => {
          // A genre cannot be both enjoyed and avoided (CONTRACT 4.2).
          const blocked = unavailable.includes(genre);
          return (
            <label
              key={genre}
              title={blocked ? `Already ${unavailableNote}` : undefined}
              className={`flex items-center gap-2 rounded-sm border border-outline-variant px-3 py-1.5 text-body-sm has-[:checked]:border-secondary has-[:checked]:bg-secondary-fixed/30 ${
                blocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              }`}
            >
              <input
                type="checkbox"
                checked={chosen.includes(genre)}
                disabled={blocked}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...chosen, genre] : chosen.filter((g) => g !== genre),
                  )
                }
                className="accent-secondary"
              />
              {genre}
              {blocked ? <span className="sr-only"> (already {unavailableNote})</span> : null}
            </label>
          );
        })}
      </div>
      {error ? <p className="text-body-sm text-error">{error}</p> : null}
    </fieldset>
  );
}
