'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { api, call } from '@/lib/api/client';
import { useSubmit } from '@/lib/forms/use-submit';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const submit = useSubmit();

  if (sentTo) {
    // The API answers the same for every email (D-001), and so do we.
    return (
      <div className="flex flex-col gap-5">
        <h1 className="font-serif text-headline-md text-on-surface">Check your email</h1>
        <Alert tone="success">
          If an account exists for {sentTo}, we have sent it a link to choose a new password. The
          link works once and expires after a short time.
        </Alert>
        <Link href="/login" className="text-body-sm underline underline-offset-4">
          Back to sign in
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
        void submit.run(async () => {
          await call(api.POST('/api/v1/auth/forgot-password', { body: { email } }));
          setSentTo(email.trim());
        });
      }}
    >
      <h1 className="font-serif text-headline-md text-on-surface">Reset your password</h1>
      <p className="text-body-md text-on-surface-variant">
        Enter the email you signed up with and we will send you a link.
      </p>
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
      <Button type="submit" busy={submit.busy}>
        {submit.busy ? 'Sending…' : 'Send reset link'}
      </Button>
      <Link
        href="/login"
        className="text-body-sm text-on-surface-variant underline underline-offset-4"
      >
        Back to sign in
      </Link>
    </form>
  );
}
