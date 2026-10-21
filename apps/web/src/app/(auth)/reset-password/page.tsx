'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { api, call } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/auth-context';
import { useSubmit } from '@/lib/forms/use-submit';

/**
 * Reset links look like /reset-password#token=... (CONTRACT 4.1). The token
 * is in the fragment, which browsers never send to a server. We read it once
 * and remove it from the address bar and history.
 */
function takeTokenFromUrl(): string | null {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return match?.[1] ?? null;
}

export default function ResetPasswordPage() {
  const auth = useAuth();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);
  const submit = useSubmit();
  // Kept in a ref: React may run this effect twice (Strict Mode), and the
  // second run would find the token already removed from the address bar.
  const taken = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (taken.current === undefined) taken.current = takeTokenFromUrl();
    setToken(taken.current);
  }, []);

  if (token === undefined) return null;

  const linkProblem = token === null || Boolean(submit.fields.token);
  if (linkProblem) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="font-serif text-headline-md text-on-surface">This link does not work</h1>
        <Alert>
          This reset link is invalid, already used or expired. Ask for a new one; it only takes a
          moment.
        </Alert>
        <Link href="/forgot-password" className="text-body-sm underline underline-offset-4">
          Send a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="font-serif text-headline-md text-on-surface">Password changed</h1>
        <Alert tone="success">
          Your password is changed and you are signed out everywhere. Sign in with the new password.
        </Alert>
        <Link href="/login" className="text-body-sm underline underline-offset-4">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (password !== confirm) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        void submit.run(async () => {
          await call(
            api.POST('/api/v1/auth/reset-password', { body: { token, newPassword: password } }),
          );
          // Every session ended on the server, this tab's included.
          auth.forget();
          setDone(true);
        });
      }}
    >
      <h1 className="font-serif text-headline-md text-on-surface">Choose a new password</h1>
      {submit.message && !submit.fields.newPassword ? <Alert>{submit.message}</Alert> : null}
      <TextField
        label="New password"
        type="password"
        name="newPassword"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={submit.fields.newPassword}
      />
      <TextField
        label="Repeat new password"
        type="password"
        name="confirmPassword"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch ? 'The two passwords are not the same.' : undefined}
      />
      <Button type="submit" busy={submit.busy}>
        {submit.busy ? 'Saving…' : 'Save new password'}
      </Button>
    </form>
  );
}
