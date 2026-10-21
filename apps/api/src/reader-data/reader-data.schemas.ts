import { z } from 'zod';
import { analysisSchema, analysisSummarySchema } from '../analysis/analysis.schemas';
import { CONTRACT_ENUMS } from '../contract/enums';
import { candidateSchema } from '../discovery/discovery.schemas';
import { requestSchema, responseSchema } from '../openapi/contract-schemas';

/** CONTRACT 4.5: feedback, reading list, comparison and delete-my-data (BE-10, D-022). */

const uuid = z.uuid();

export const feedbackRequestSchema = requestSchema(
  'FeedbackRequest',
  z.object({
    analysisId: uuid,
    target: z.enum(CONTRACT_ENUMS.feedbackTarget),
    value: z.enum(CONTRACT_ENUMS.feedbackValue),
  }),
);

export const feedbackSavedSchema = responseSchema(
  'FeedbackSaved',
  z.object({
    target: z.enum(CONTRACT_ENUMS.feedbackTarget),
    value: z.enum(CONTRACT_ENUMS.feedbackValue),
    updatedAt: z.iso.datetime(),
  }),
);

export const readingListAddSchema = requestSchema('ReadingListAdd', z.object({ editionId: uuid }));

export const readingListEntrySchema = responseSchema(
  'ReadingListEntry',
  z.object({ editionId: uuid, addedAt: z.iso.datetime() }),
);

/**
 * Where an item stands in the list (LIST-2): `ranked` items have a match of
 * medium or high confidence and are ordered by score; `low_confidence` items
 * have a score that is low confidence (including fallback models) and are
 * labeled, not ranked; `no_match` items have no score yet.
 */
export const READING_LIST_GROUPS = CONTRACT_ENUMS.readingListGroup;

const readingListItemSchema = z.object({
  edition: candidateSchema,
  addedAt: z.iso.datetime(),
  /** The reader's latest finished analysis of this edition, or null when there is none. */
  analysisId: uuid.nullable(),
  group: z.enum(READING_LIST_GROUPS),
  /** From that analysis, as stored (LIST-1); null when there is no analysis. */
  personalMatch: analysisSummarySchema.shape.personalMatch.nullable(),
});

export const readingListSchema = responseSchema(
  'ReadingList',
  z.object({ items: z.array(readingListItemSchema) }).superRefine((list, ctx) => {
    list.items.forEach((item, i) => {
      const pm = item.personalMatch;
      const scored = pm?.status === 'done' && pm.score !== null;
      const confident = scored && !pm!.isFallback && pm!.evidenceConfidence?.level !== 'low';
      const expected = !scored ? 'no_match' : confident ? 'ranked' : 'low_confidence';
      if (item.group !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'group'],
          message: `group must be ${expected} for this personal match (LIST-2)`,
        });
      }
      if (pm === null && item.analysisId !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'personalMatch'],
          message: 'an analysed item has a personal match',
        });
      }
    });
    // Groups come in order, and ranked items by score, highest first (LIST-1).
    const order = list.items.map((item) => READING_LIST_GROUPS.indexOf(item.group));
    if (order.some((g, i) => i > 0 && g < order[i - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'groups are out of order' });
    }
    const scores = list.items
      .filter((item) => item.group === 'ranked')
      .map((item) => item.personalMatch!.score!);
    if (scores.some((s, i) => i > 0 && s > scores[i - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'ranked items are not by score' });
    }
  }),
);

export const comparisonSchema = responseSchema(
  'Comparison',
  z.object({
    a: analysisSchema,
    b: analysisSchema,
    /**
     * The book traits whose values differ between the two analyses. An empty
     * list means that side's trait is unknown.
     */
    traitDifferences: z.array(
      z.object({
        trait: z.enum(CONTRACT_ENUMS.traitKey),
        a: z.array(z.string()),
        b: z.array(z.string()),
      }),
    ),
  }),
);

export const deleteMyDataSchema = requestSchema(
  'DeleteMyDataRequest',
  z.object({ password: z.string().min(1).max(1024) }),
);

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
export type FeedbackSaved = z.infer<typeof feedbackSavedSchema>;
export type ReadingList = z.infer<typeof readingListSchema>;
export type ReadingListItem = ReadingList['items'][number];
export type ReadingListEntry = z.infer<typeof readingListEntrySchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
