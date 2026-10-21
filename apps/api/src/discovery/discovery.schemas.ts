import { z } from 'zod';
import { CONTRACT_ENUMS } from '../contract/enums';
import { responseSchema } from '../openapi/contract-schemas';
import type { CatalogHit } from './catalog-search';

/**
 * CONTRACT 4.3. A candidate carries every identifying field the catalog has
 * (DISC-1), so the reader can tell editions apart and the result can name the
 * edition it analysed (DISC-5). Unknown fields are null.
 */
export const candidateSchema = responseSchema(
  'Candidate',
  z.object({
    editionId: z.uuid(),
    title: z.string(),
    subtitle: z.string().nullable(),
    author: z.string().nullable(),
    year: z.int().nullable(),
    language: z.string().nullable(),
    publisher: z.string().nullable(),
    format: z.string().nullable(),
    coverUrl: z.string().nullable(),
  }),
);

/** Whether an external source was asked, and how that went. null when it was not needed. */
const externalSchema = z
  .object({
    source: z.literal('open_library'),
    outcome: z.enum(CONTRACT_ENUMS.sourceOutcome),
  })
  .nullable();

export const bookSearchResultSchema = responseSchema(
  'BookSearchResult',
  z.object({
    candidates: z.array(candidateSchema),
    external: externalSchema,
  }),
);

export const scanResultSchema = responseSchema(
  'ScanResult',
  z.object({
    outcome: z.enum(['identified', 'uncertain']),
    candidates: z.array(candidateSchema),
    /** What the cover says, so the confirmation screen can offer a typed search. */
    recognized: z.object({
      title: z.string(),
      subtitle: z.string().nullable(),
      authors: z.array(z.string()),
    }),
    external: externalSchema,
  }),
);

export type CandidateView = z.infer<typeof candidateSchema>;
export type BookSearchResult = z.infer<typeof bookSearchResultSchema>;
export type ScanResult = z.infer<typeof scanResultSchema>;
export type ExternalLookup = z.infer<typeof externalSchema>;

/** Query string of GET /books/search (documented with @ApiQuery, so not registered). */
export const searchQuerySchema = z.object({
  q: z
    .string({ error: 'Type a title, author or ISBN.' })
    .trim()
    .min(1, 'Type a title, author or ISBN.')
    .max(200, 'Use at most 200 characters.')
    .refine((q) => /[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(q), 'Type at least 2 letters or digits.'),
});

export function toCandidate(hit: CatalogHit): CandidateView {
  return {
    editionId: hit.editionId,
    title: hit.title,
    subtitle: hit.subtitle,
    author: hit.authors.length > 0 ? hit.authors.join(', ') : null,
    year: hit.year,
    language: hit.language,
    publisher: hit.publisher,
    format: hit.format,
    coverUrl: hit.coverUrl,
  };
}
