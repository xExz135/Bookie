import { randomInt } from 'node:crypto';

/** A valid, random ISBN-13, so parallel test files never share one. */
export function randomIsbn13(): string {
  const body = `978${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const sum = [...body].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** The same ISBN with hyphens, as a reader might type it. */
export function hyphenate(isbn13: string): string {
  return `${isbn13.slice(0, 3)}-${isbn13.slice(3, 4)}-${isbn13.slice(4, 7)}-${isbn13.slice(7, 12)}-${isbn13.slice(12)}`;
}
