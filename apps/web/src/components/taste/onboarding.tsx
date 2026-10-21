'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-context';
import { getTasteProfile, skipOnboarding, type TasteProfile } from '@/lib/taste/api';

const CHOICES = [
  {
    href: '/taste/import',
    title: 'Import ratings',
    text: 'Upload your Goodreads or StoryGraph export. Only titles, authors and star ratings are kept.',
  },
  {
    href: '/taste/rate',
    title: 'Quick rate',
    text: 'Pick books you have read from a list and give each one 1 to 5 stars.',
  },
  {
    href: '/taste/questionnaire',
    title: 'Questionnaire',
    text: 'Optional: genres you like or avoid, your preferred pace, themes to avoid. Anything you leave out stays unknown.',
  },
] as const;

/**
 * First sign-in (D-002): import, quick rate, the optional questionnaire, or
 * skip. Shown until the reader saves something or skips; it stays reachable
 * from the taste profile page afterwards.
 */
export function Onboarding() {
  const { reloadUser } = useAuth();
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTasteProfile().then(
      (p) => !cancelled && setProfile(p),
      // The thresholds are only for the explanation; the choices work without them.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function skip() {
    setSkipping(true);
    setError(null);
    try {
      await skipOnboarding();
      await reloadUser();
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.code === 'CONFLICT'
          ? 'Skipping is turned off for now. Please choose one of the options above.'
          : errorMessage(e),
      );
      setSkipping(false);
    }
  }

  return (
    <section aria-labelledby="welcome-title" className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-label-sm uppercase text-secondary">Welcome to Bookie</p>
        <h1
          id="welcome-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Tell us what you like to read
        </h1>
        <p className="font-serif text-body-lg text-on-surface-variant">
          Bookie shows what reviewers say about a book and, once it knows your taste, how closely
          the book matches the books you rated. The two are always kept apart.
        </p>
        {profile ? (
          <p className="text-body-md text-on-surface-variant">
            Rate at least {profile.hardFloor} books to see a personal match;{' '}
            {profile.minForConfidence} or more make it more reliable.
          </p>
        ) : null}
      </header>

      <ul className="grid gap-3 sm:grid-cols-3">
        {CHOICES.map((choice) => (
          <li key={choice.href}>
            <Link
              href={choice.href}
              className="flex h-full flex-col gap-2 rounded-md border border-outline-variant bg-surface-container-lowest p-5 transition-colors hover:border-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-on-surface"
            >
              <span className="font-serif text-headline-sm text-on-surface">{choice.title}</span>
              <span className="text-body-md text-on-surface-variant">{choice.text}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex flex-col items-start gap-2 border-t border-outline-variant/60 pt-5">
        <Button variant="secondary" busy={skipping} onClick={() => void skip()}>
          {skipping ? 'Skipping…' : 'Skip for now'}
        </Button>
        <p className="text-body-sm text-on-surface-variant">
          You will still see what reviewers say about every book. You can add ratings later from
          your taste profile.
        </p>
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </section>
  );
}
