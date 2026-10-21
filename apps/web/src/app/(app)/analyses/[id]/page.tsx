'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

/**
 * Placeholder until FE-5 builds the result screen. Discovery (FE-4) starts an
 * analysis and comes here with its id.
 */
export default function AnalysisPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <h1 className="font-serif text-headline-lg-mobile text-on-surface">Analysis started</h1>
      <p className="font-serif text-body-lg text-on-surface-variant">
        The result screen is being built next. This analysis keeps its id ({id}), so it will be here
        when that screen arrives.
      </p>
      <Link href="/" className="text-label-lg text-secondary underline underline-offset-4">
        Find another book
      </Link>
    </section>
  );
}
