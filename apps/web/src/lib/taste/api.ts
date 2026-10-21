import { api, call } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/types';

export type TasteProfile = Schemas['TasteProfile'];
export type Questionnaire = TasteProfile['questionnaire'];
export type QuestionnaireRequest = Schemas['QuestionnaireRequest'];
export type QuestionnaireOptions = Schemas['QuestionnaireOptions'];
export type RatedBook = Schemas['RatedBook'];
export type RatingList = Schemas['RatingList'];
export type CatalogSearchResult = Schemas['CatalogSearchResult'];
export type CatalogItem = CatalogSearchResult['items'][number];
export type RatingImport = Schemas['RatingImport'];
export type UnmatchedRow = RatingImport['unmatched'][number];
export type Resolution = Schemas['ImportConfirmRequest']['resolutions'][number];
/** What every save returns: the new profile version and how many books are rated. */
export type ProfileSaved = Schemas['ProfileSaved'];

/** The reader's current taste profile and the thresholds the server uses (CONTRACT 4.2). */
export function getTasteProfile(): Promise<TasteProfile> {
  return call(api.GET('/api/v1/taste-profile'));
}

/** The current version's ratings, by title. */
export function listRatings(cursor?: string): Promise<RatingList> {
  return call(api.GET('/api/v1/ratings', { params: { query: cursor ? { cursor } : {} } }));
}

/** Rates a book 1 to 5; replaces an earlier rating of it. Every save is a new profile version. */
export function rateBook(editionId: string, rating: number): Promise<ProfileSaved> {
  return call(
    api.PUT('/api/v1/ratings/{editionId}', {
      params: { path: { editionId } },
      body: { rating },
    }),
  );
}

export function removeRating(editionId: string): Promise<ProfileSaved> {
  return call(api.DELETE('/api/v1/ratings/{editionId}', { params: { path: { editionId } } }));
}

/** Books to quick-rate: the most-rated ones without `q`, the discovery search with it. */
export function searchCatalog(q?: string): Promise<CatalogSearchResult> {
  return call(api.GET('/api/v1/catalog/search', { params: { query: q ? { q } : {} } }));
}

/** Uploads a Goodreads or StoryGraph export. Matching continues in the background. */
export function startImport(file: File): Promise<Schemas['ImportStarted']> {
  const form = new FormData();
  form.append('file', file, file.name);
  return call(
    api.POST('/api/v1/ratings/import', {
      // openapi-fetch sends FormData as multipart and lets the browser set the boundary.
      body: form as unknown as { file: string },
    }),
  );
}

export function getImport(importId: string): Promise<RatingImport> {
  return call(api.GET('/api/v1/ratings/import/{importId}', { params: { path: { importId } } }));
}

/** Saves the import. Rows left out of `resolutions` are skipped. */
export function confirmImport(importId: string, resolutions: Resolution[]): Promise<ProfileSaved> {
  return call(
    api.POST('/api/v1/ratings/import/{importId}/confirm', {
      params: { path: { importId } },
      body: { resolutions },
    }),
  );
}

export function getQuestionnaireOptions(): Promise<QuestionnaireOptions> {
  return call(api.GET('/api/v1/questionnaire/options'));
}

/** Replaces all four answers. `null` means unknown, never a dislike (ONB-3). */
export function saveQuestionnaire(answers: QuestionnaireRequest): Promise<ProfileSaved> {
  return call(api.PUT('/api/v1/questionnaire', { body: answers }));
}

/** "Skip for now" (D-002): public results stay available. */
export function skipOnboarding(): Promise<void> {
  return call(api.POST('/api/v1/onboarding/skip')).then(() => undefined);
}
