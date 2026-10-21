'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { Wordmark } from './wordmark';

const NAV = [{ href: '/', label: 'Discover' }];

/** Header and frame for signed-in pages. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-outline-variant/60 bg-surface-container-lowest">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <div className="flex items-center gap-6">
            <Wordmark />
            <nav aria-label="Main">
              <ul className="flex gap-4">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={pathname === item.href ? 'page' : undefined}
                      className="text-label-lg text-on-surface-variant hover:text-on-surface aria-[current=page]:text-on-surface"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-body-sm text-on-surface-variant sm:inline">
              {user?.displayName}
            </span>
            <button
              type="button"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await logout();
                } finally {
                  router.replace('/login');
                }
              }}
              className="rounded-sm border border-outline-variant px-3 py-1.5 text-label-md text-on-surface hover:bg-surface-container-low disabled:opacity-60"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 sm:px-8">{children}</main>
    </div>
  );
}
