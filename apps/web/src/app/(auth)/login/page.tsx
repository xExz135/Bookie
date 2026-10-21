'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { safeNext, useAuth } from '@/lib/auth/auth-context';
import { useSubmit } from '@/lib/forms/use-submit';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const auth = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = useSubmit();

  useEffect(() => {
    if (auth.status === 'authenticated') router.replace(next);
  }, [auth.status, next, router]);

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit.run(async () => {
          await auth.login(email, password);
          router.replace(next);
        });
      }}
    >
      <h1 className="font-serif text-headline-md text-on-surface">Sign in</h1>
      {params.get('reason') === 'expired' && !submit.message ? (
        <Alert tone="info">Your session ended. Please sign in again.</Alert>
      ) : null}
      {submit.message ? <Alert>{submit.message}</Alert> : null}
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={submit.fields.email}
      />
      <TextField
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={submit.fields.password}
      />
      <Button type="submit" busy={submit.busy}>
        {submit.busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="flex flex-col gap-2 text-body-sm text-on-surface-variant sm:flex-row sm:justify-between">
        <Link href="/forgot-password" className="underline underline-offset-4">
          Forgot your password?
        </Link>
        <Link
          href={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="underline underline-offset-4"
        >
          Create an account
        </Link>
      </div>
    </form>
  );
}
