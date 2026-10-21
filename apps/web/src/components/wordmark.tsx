import Link from 'next/link';

export function Wordmark({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="font-serif text-headline-sm tracking-tight text-on-surface">
      Bookie
    </Link>
  );
}
