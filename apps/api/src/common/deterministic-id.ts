import { createHash } from 'node:crypto';

/** Fixed namespace for Bookie's name-based IDs. Never change it: IDs would change. */
const NAMESPACE = Buffer.from('3b9f5c2e7a1d4f6b8c0e2a4d6f8b1c3e', 'hex');

/**
 * Name-based UUID (version 5). The same name always gives the same ID, so a
 * dataset import can be re-run without creating duplicates.
 * Example: deterministicUuid('goodreads:book:5333265').
 */
export function deterministicUuid(name: string): string {
  const hash = createHash('sha1').update(NAMESPACE).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
