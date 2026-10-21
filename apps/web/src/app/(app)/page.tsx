'use client';

import { useAuth } from '@/lib/auth/auth-context';

/** Home. Search and cover scan arrive with FE-4; taste capture with FE-2. */
export default function HomePage() {
  const { user } = useAuth();
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <h1 className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg">
        Welcome, {user?.displayName}
      </h1>
      <p className="font-serif text-body-lg text-on-surface-variant">
        Search for a book or scan its cover to see what readers say about it, and how well it fits
        your taste. Those screens are being built next.
      </p>
    </section>
  );
}
