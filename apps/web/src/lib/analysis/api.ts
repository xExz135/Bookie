import { api, call } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/types';

export type Analysis = Schemas['Analysis'];
export type Step = Analysis['steps'][number];
export type StepName = Step['name'];
export type PublicReception = Analysis['publicReception'];
export type PersonalMatch = Analysis['personalMatch'];
export type Evidence = PublicReception['evidence'][number];
export type Confidence = NonNullable<PublicReception['evidenceConfidence']>;

/** One analysis (CONTRACT 4.4). Poll it again after `pollAfterMs` while it runs. */
export function getAnalysis(id: string): Promise<Analysis> {
  return call(api.GET('/api/v1/analyses/{id}', { params: { path: { id } } }));
}

/**
 * Runs failed steps again (RES-2). With `steps`, only those; the API refuses
 * a step that did not fail. Done steps are never repeated.
 */
export function retryAnalysis(id: string, steps?: StepName[]): Promise<Analysis> {
  return call(
    api.POST('/api/v1/analyses/{id}/retry', {
      params: { path: { id } },
      body: steps ? { steps } : {},
    }),
  );
}
