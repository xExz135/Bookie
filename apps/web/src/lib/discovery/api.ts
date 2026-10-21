import { api, call, session } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/types';
import { API_URL } from '@/lib/config';

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

/**
 * Starts (or joins) the analysis of the confirmed edition (CONTRACT 4.4).
 * The `/analyses` paths are not in openapi.json until BE-8 builds them, only
 * their shapes, so this one call goes through the session directly. Switch to
 * `api.POST('/api/v1/analyses')` once `pnpm generate` includes the path.
 */
export function startAnalysis(editionId: string): Promise<Analysis> {
  const body: Schemas['StartAnalysis'] = { editionId };
  return call(
    (async () => {
      const response = await session.fetch(
        new Request(`${API_URL}/api/v1/analyses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const json: unknown = await response.json().catch(() => undefined);
      return response.ok ? { data: json as Analysis, response } : { error: json, response };
    })(),
  );
}
