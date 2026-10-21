import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="font-serif text-headline-md text-on-surface">Page not found</h1>
      <Link href="/" className="text-label-lg text-secondary underline underline-offset-4">
        Go to Bookie
      </Link>
    </main>
  );
}
