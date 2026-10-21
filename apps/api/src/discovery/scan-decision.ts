import type { CatalogHit } from './catalog-search';
import type { CoverReading } from './cover-reader';

export interface ScanThresholds {
  /** Title match a book needs to be plausible (SCAN_MIN_CONFIDENCE). */
  minTitle: number;
  /** Author match a book needs when the cover shows an author (SCAN_AUTHOR_MIN_MATCH). */
  minAuthor: number;
}

/** A book matches the cover well enough to be a real option. */
export function isPlausible(
  hit: Pick<CatalogHit, 'titleScore' | 'authorScore'>,
  reading: Pick<CoverReading, 'authors'>,
  t: ScanThresholds,
): boolean {
  if ((hit.titleScore ?? 0) < t.minTitle) return false;
  return reading.authors.length === 0 || (hit.authorScore ?? 0) >= t.minAuthor;
}

/**
 * Decides, in code, whether a scan is identified (spec 6, DISC-2). Only when
 * all of these hold:
 * - the model read title and author with high certainty,
 * - exactly one catalog book matches both well enough.
 * Otherwise the scan is uncertain and the reader confirms ("the app never
 * auto-selects when more than one plausible match exists"). Plausible books
 * are listed first either way.
 */
export function decideScan<H extends Pick<CatalogHit, 'titleScore' | 'authorScore'>>(
  reading: Pick<CoverReading, 'authors' | 'certainty'>,
  hits: H[],
  t: ScanThresholds,
): { outcome: 'identified' | 'uncertain'; ordered: H[] } {
  const plausible = hits.filter((h) => isPlausible(h, reading, t));
  const others = hits.filter((h) => !plausible.includes(h));
  const identified =
    reading.certainty === 'high' && reading.authors.length > 0 && plausible.length === 1;
  return { outcome: identified ? 'identified' : 'uncertain', ordered: [...plausible, ...others] };
}
