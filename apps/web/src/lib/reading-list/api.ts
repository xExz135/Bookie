import { api, call } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/types';

export type ReadingList = Schemas['ReadingList'];
export type ReadingListItem = ReadingList['items'][number];
export type ReadingListGroup = ReadingListItem['group'];
export type Comparison = Schemas['Comparison'];
export type TraitDifference = Comparison['traitDifferences'][number];

/**
 * The reader's saved books, in the order to show and with the group each is
 * placed in (CONTRACT 4.5, LIST-1, LIST-2). Never re-sort it.
 */
export function getReadingList(): Promise<ReadingList> {
  return call(api.GET('/api/v1/reading-list'));
}

/** Saves a book; saving one already on the list is not an error. */
export function addToReadingList(editionId: string): Promise<Schemas['ReadingListEntry']> {
  return call(api.POST('/api/v1/reading-list', { body: { editionId } }));
}

/** Removes a book; removing one not on the list is not an error. */
export async function removeFromReadingList(editionId: string): Promise<void> {
  await call(api.DELETE('/api/v1/reading-list/{editionId}', { params: { path: { editionId } } }));
}

/** Two of the reader's analyses side by side, with the traits that differ (CONTRACT 4.5). */
export function compareAnalyses(a: string, b: string): Promise<Comparison> {
  return call(api.GET('/api/v1/compare', { params: { query: { a, b } } }));
}
