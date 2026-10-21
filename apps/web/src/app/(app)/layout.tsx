'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppShell } from '@/components/app-shell';
import { FullPageStatus } from '@/components/full-page-status';
import { useAuth } from '@/lib/auth/auth-context';

/**
 * Every page in this group needs a signed-in reader (SEC-2). The API refuses
 * them without a token anyway; this keeps the reader from seeing empty pages
 * and brings them back here after signing in.
 */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { status, sessionExpired } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status !== 'anonymous') return;
    const here = window.location.pathname + window.location.search;
    const params = new URLSearchParams();
    if (here !== '/') params.set('next', here);
    if (sessionExpired) params.set('reason', 'expired');
    const query = params.toString();
    router.replace(`/login${query ? `?${query}` : ''}`);
  }, [status, sessionExpired, router]);

  if (status !== 'authenticated') {
    return <FullPageStatus label={status === 'loading' ? 'Loading…' : 'Taking you to sign in…'} />;
  }
  return <AppShell>{children}</AppShell>;
}
