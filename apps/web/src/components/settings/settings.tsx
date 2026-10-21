'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { TextField } from '@/components/ui/text-field';
import { deleteMyData } from '@/lib/account/api';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-context';

/** What delete-my-data removes and keeps (CONTRACT 4.5, D-022). */
const REMOVED = [
  'Every book you rated, and every earlier version of your taste profile',
  'Your questionnaire answers and rating imports',
  'Every analysis in your history, with its personal match',
  'Your Accurate / Not for me feedback',
  'Your reading list',
  'Your part in the user study, with its predictions',
];
const KEPT = [
  'Your account: email, password and display name, so you stay signed in',
  'How many scans and refreshes you have used, so their limits are not reset',
  'Shared book data and review summaries, which belong to no reader',
];

/**
 * Settings (FE-9): the account, where to edit ratings, and delete my data
 * (SEC-3). Deleting asks for the password and an explicit confirmation, and
 * says exactly what goes and what stays.
 */
export function Settings() {
  const { user } = useAuth();
  return (
    <section aria-labelledby="settings-title" className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-label-sm uppercase text-secondary">Account</p>
        <h1
          id="settings-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Settings
        </h1>
      </header>

      <div className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
        <h2 className="font-serif text-headline-sm text-on-surface">Your account</h2>
        <dl className="grid gap-x-4 gap-y-1 text-body-md sm:grid-cols-[10rem_1fr]">
          <dt className="text-on-surface-variant">Display name</dt>
          <dd className="text-on-surface">{user?.displayName}</dd>
          <dt className="text-on-surface-variant">Email</dt>
          <dd className="break-all text-on-surface">{user?.email}</dd>
        </dl>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
        <h2 className="font-serif text-headline-sm text-on-surface">Your ratings</h2>
        <p className="text-body-md text-on-surface-variant">
          Change or remove a rating, rate more books, import an export or edit your questionnaire
          answers on your taste profile. Every change is saved as a new version; results made with
          an earlier version are marked outdated and can be recalculated.
        </p>
        <Link
          href="/taste"
          className="self-start text-label-lg text-secondary underline underline-offset-4"
        >
          Edit your taste profile
        </Link>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6">
        <h2 className="font-serif text-headline-sm text-on-surface">User study</h2>
        <p className="text-body-md text-on-surface-variant">
          See how well Bookie predicts books you have already rated: some are hidden from the model,
          and its predictions are shown next to your own ratings.
        </p>
        <Link
          href="/study"
          className="self-start text-label-lg text-secondary underline underline-offset-4"
        >
          Take part in the user study
        </Link>
      </div>

      <DeleteMyData />
    </section>
  );
}

function DeleteMyData() {
  const router = useRouter();
  const { reloadUser } = useAuth();
  const confirmId = useId();
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed || password.length === 0) return;
    setDeleting(true);
    setError(null);
    setPasswordError(undefined);
    try {
      await deleteMyData(password);
      setDone(true);
      setPassword('');
      // The reader is back at onboarding (D-022): read them again, then start over at home.
      await reloadUser().catch(() => undefined);
      router.push('/');
    } catch (e) {
      if (e instanceof ApiRequestError && e.fields.password) setPasswordError(e.fields.password);
      else setError(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-error/40 bg-surface-container-lowest p-5 sm:p-6">
      <h2 className="font-serif text-headline-sm text-on-surface">Delete my data</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-label-md uppercase text-on-surface-variant">Removed for good</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-on-surface">
            {REMOVED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-label-md uppercase text-on-surface-variant">Kept</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-on-surface-variant">
            {KEPT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        This cannot be undone. Afterwards you start again from the welcome screen.
      </p>

      {done ? (
        <Alert tone="success">Your data was deleted. Taking you to the welcome screen…</Alert>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <TextField
            label="Your password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={passwordError}
            hint="To make sure it is you."
          />
          <label htmlFor={confirmId} className="flex cursor-pointer items-start gap-3 text-body-md">
            <input
              id={confirmId}
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1 size-4 accent-error"
            />
            I understand that my ratings, history, feedback, reading list and study results will be
            deleted for good.
          </label>
          <div className="flex flex-col items-start gap-3">
            <button
              type="submit"
              disabled={!confirmed || password.length === 0 || deleting}
              aria-busy={deleting || undefined}
              className="inline-flex items-center justify-center rounded-sm bg-error px-5 py-3 text-label-lg text-on-error transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete my data'}
            </button>
            {error ? <Alert>{error}</Alert> : null}
          </div>
        </form>
      )}
    </div>
  );
}
