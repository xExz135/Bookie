import { api, call } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/types';

export type Candidate = Schemas['Candidate'];
export type BookSearchResult = Schemas['BookSearchResult'];
export type ScanResult = Schemas['ScanResult'];
export type Analysis = Schemas['Analysis'];

/** Typed search (CONTRACT 4.3): at most three candidates, one per book. */
export function searchBooks(q: string): Promise<BookSearchResult> {
  return call(api.GET('/api/v1/books/search', { params: { query: { q } } }));
}

/** Cover scan (CONTRACT 4.3). The photo is already resized to JPEG by `prepareCover`. */
export function scanCover(jpeg: Blob): Promise<ScanResult> {
  const form = new FormData();
  form.append('image', jpeg, 'cover.jpg');
  return call(
    api.POST('/api/v1/scan', {
      // openapi-fetch sends FormData as multipart and lets the browser set the boundary.
      body: form as unknown as { image: string },
    }),
  );
}

/** Starts (or joins) the analysis of the confirmed edition (CONTRACT 4.4). */
export function startAnalysis(editionId: string): Promise<Analysis> {
  return call(api.POST('/api/v1/analyses', { body: { editionId } }));
}
