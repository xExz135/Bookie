'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { safeNext, useAuth } from '@/lib/auth/auth-context';
import { useSubmit } from '@/lib/forms/use-submit';

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const auth = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [displayName, setDisplayName] = useState('');
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
          // Registering signs the reader in right away (D-001).
          await auth.register({ email, password, displayName });
          router.replace(next);
        });
      }}
    >
      <h1 className="font-serif text-headline-md text-on-surface">Create your account</h1>
      {submit.code === 'EMAIL_IN_USE' ? (
        <Alert>
          {submit.message}{' '}
          <Link href="/login" className="font-semibold underline underline-offset-4">
            Sign in instead
          </Link>
        </Alert>
      ) : submit.message ? (
        <Alert>{submit.message}</Alert>
      ) : null}
      <TextField
        label="Display name"
        name="displayName"
        autoComplete="nickname"
        required
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        error={submit.fields.displayName}
      />
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
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={submit.fields.password}
      />
      <Button type="submit" busy={submit.busy}>
        {submit.busy ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-body-sm text-on-surface-variant">
        Already have an account?{' '}
        <Link href="/login" className="underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </form>
  );
}
