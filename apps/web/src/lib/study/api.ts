import { api, call } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/types';

export type Study = Schemas['Study'];
export type HeldOutBook = Study['heldOut'][number];

/** Whether the reader can join the user study, or their held-out books (CONTRACT 4.6). */
export function getStudy(): Promise<Study> {
  return call(api.GET('/api/v1/study'));
}

/** Joins with the reader's consent; the predictions are made now. `409` when not eligible. */
export function joinStudy(): Promise<Study> {
  return call(api.POST('/api/v1/study', { body: { consent: true } }));
}

/** Leaves the study; its held-out books and predictions are deleted. */
export async function leaveStudy(): Promise<void> {
  await call(api.DELETE('/api/v1/study'));
}
