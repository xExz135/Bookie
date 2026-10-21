import { z } from 'zod';
import { candidateSchema } from '../discovery/discovery.schemas';
import { requestSchema, responseSchema } from '../openapi/contract-schemas';

/** CONTRACT 4.2. Unknown is null and is never treated as a dislike (ONB-3, D-011). */

export const PACES = ['slow', 'moderate', 'fast'] as const;
export const SENSITIVITIES = ['high', 'moderate', 'low'] as const;

const questionnaireFields = {
  likedGenres: z.array(z.string()).nullable(),
  dislikedGenres: z.array(z.string()).nullable(),
  pace: z.enum(PACES).nullable(),
  themesToAvoid: z
    .array(z.object({ theme: z.string(), sensitivity: z.enum(SENSITIVITIES) }))
    .nullable(),
};

export const tasteProfileSchema = responseSchema(
  'TasteProfile',
  z.object({
    /** 0 before the first save. */
    version: z.int().min(0),
    ratedCount: z.int().min(0),
    minForConfidence: z.int().positive(),
    hardFloor: z.int().positive(),
    questionnaire: z.object(questionnaireFields),
    createdAt: z.iso.datetime().nullable(),
  }),
);

export const profileSavedSchema = responseSchema(
  'ProfileSaved',
  z.object({ tasteProfileVersion: z.int().min(0), ratedCount: z.int().min(0) }),
);

export const ratedBookSchema = responseSchema(
  'RatedBook',
  candidateSchema.extend({
    rating: z.int().min(1).max(5),
    origin: z.enum(['quick_rate', 'imported']),
  }),
);

export const ratingListSchema = responseSchema(
  'RatingList',
  z.object({ items: z.array(ratedBookSchema), nextCursor: z.string().nullable() }),
);

export const catalogItemSchema = responseSchema(
  'CatalogItem',
  candidateSchema.extend({
    /** The reader's current rating of this edition, or null. */
    yourRating: z.int().min(1).max(5).nullable(),
  }),
);

export const catalogSearchResultSchema = responseSchema(
  'CatalogSearchResult',
  z.object({
    items: z.array(catalogItemSchema),
    external: z
      .object({
        source: z.literal('open_library'),
        outcome: z.enum(['ok', 'empty', 'failed', 'rate_limited', 'not_permitted']),
      })
      .nullable(),
  }),
);

export const questionnaireOptionsSchema = responseSchema(
  'QuestionnaireOptions',
  z.object({
    genres: z.array(z.string()),
    themes: z.array(z.string()),
    paces: z.array(z.enum(PACES)),
  }),
);

export const importStartedSchema = responseSchema(
  'ImportStarted',
  z.object({ importId: z.uuid() }),
);

export const ratingImportSchema = responseSchema(
  'RatingImport',
  z.object({
    importId: z.uuid(),
    status: z.enum(['processing', 'needs_review', 'confirmed', 'failed']),
    format: z.enum(['goodreads', 'storygraph']).nullable(),
    totalRows: z.int().min(0),
    matchedCount: z.int().min(0),
    /** Rows left out of the file: no rating, or not read yet. */
    ignoredRows: z.int().min(0),
    unmatched: z.array(
      z.object({
        rowIndex: z.int().positive(),
        rawTitle: z.string(),
        rawAuthor: z.string().nullable(),
        rating: z.int().min(1).max(5),
        candidates: z.array(candidateSchema),
      }),
    ),
  }),
);

export const ratingRequestSchema = requestSchema(
  'RatingRequest',
  z.object({
    rating: z
      .int({ error: 'Rate from 1 to 5.' })
      .min(1, 'Rate from 1 to 5.')
      .max(5, 'Rate from 1 to 5.'),
  }),
);

export const questionnaireRequestSchema = requestSchema(
  'QuestionnaireRequest',
  z
    .object({
      likedGenres: questionnaireFields.likedGenres.optional(),
      dislikedGenres: questionnaireFields.dislikedGenres.optional(),
      pace: questionnaireFields.pace.optional(),
      themesToAvoid: questionnaireFields.themesToAvoid.optional(),
    })
    .superRefine((q, ctx) => {
      const liked = new Set(q.likedGenres ?? []);
      for (const genre of q.dislikedGenres ?? []) {
        if (liked.has(genre)) {
          ctx.addIssue({
            code: 'custom',
            path: ['dislikedGenres'],
            message: `"${genre}" cannot be both liked and disliked.`,
          });
        }
      }
      const themes = (q.themesToAvoid ?? []).map((t) => t.theme);
      if (new Set(themes).size !== themes.length) {
        ctx.addIssue({ code: 'custom', path: ['themesToAvoid'], message: 'List each theme once.' });
      }
    }),
);

export const importConfirmRequestSchema = requestSchema(
  'ImportConfirmRequest',
  z.object({
    resolutions: z
      .array(
        z.union([
          z.strictObject({ rowIndex: z.int().positive(), editionId: z.uuid() }),
          z.strictObject({ rowIndex: z.int().positive(), skip: z.literal(true) }),
        ]),
      )
      .max(20_000)
      .default([]),
  }),
);

export const ratingListQuerySchema = z.object({
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const catalogQuerySchema = z.object({
  q: z.string().trim().max(200, 'Use at most 200 characters.').optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type TasteProfileView = z.infer<typeof tasteProfileSchema>;
export type ProfileSaved = z.infer<typeof profileSavedSchema>;
export type RatingList = z.infer<typeof ratingListSchema>;
export type CatalogSearchResult = z.infer<typeof catalogSearchResultSchema>;
export type QuestionnaireOptions = z.infer<typeof questionnaireOptionsSchema>;
export type QuestionnaireRequest = z.output<typeof questionnaireRequestSchema>;
export type RatingImportView = z.infer<typeof ratingImportSchema>;
