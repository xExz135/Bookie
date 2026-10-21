import { z } from 'zod';
import { CONTRACT_ENUMS } from '../contract/enums';
import { candidateSchema } from '../discovery/discovery.schemas';
import { requestSchema, responseSchema } from '../openapi/contract-schemas';

/** CONTRACT 4.6: the user study (spec 9, FE-10, D-027). */

export const STUDY_STATUSES = ['not_eligible', 'eligible', 'joined'] as const;
export const STUDY_INELIGIBLE_REASONS = [
  'too_few_ratings',
  'too_few_known_books',
  'no_model',
] as const;

const score = z.number().min(1).max(5);

const heldOutBookSchema = z.object({
  edition: candidateSchema,
  /** The reader's own rating, which the model did not see. */
  yourRating: z.number().int().min(1).max(5),
  /** The shipped model's prediction from the reader's other ratings. */
  prediction: z.object({
    score,
    modelId: z.enum(CONTRACT_ENUMS.modelId),
    confidence: z.enum(CONTRACT_ENUMS.confidenceLevel),
  }),
  /** B0, the shrunk average rating of the book: what the model is compared against (spec 9). */
  baseline: z.object({ score, modelId: z.literal('B0') }),
});

export const studySchema = responseSchema(
  'Study',
  z
    .object({
      status: z.enum(STUDY_STATUSES),
      /** Why the reader cannot join yet; null unless `status` is `not_eligible`. */
      ineligibleReason: z.enum(STUDY_INELIGIBLE_REASONS).nullable(),
      requirements: z.object({
        /** STUDY_MIN_RATED_BOOKS */
        minRatedBooks: z.number().int().min(1),
        /** STUDY_HELD_OUT_BOOKS */
        heldOutBooks: z.number().int().min(1),
      }),
      /** Rated books in the reader's current taste profile. */
      ratedCount: z.number().int().min(0),
      /** Of those, the books the learned model knows; held-out books are chosen among them. */
      knownCount: z.number().int().min(0),
      joinedAt: z.iso.datetime().nullable(),
      /** The release the predictions came from; null until joined. */
      modelVersion: z.string().nullable(),
      scale: z.object({ min: z.literal(1), max: z.literal(5) }),
      /** The held-out books in the order to show; empty until joined. */
      heldOut: z.array(heldOutBookSchema),
    })
    .superRefine((s, ctx) => {
      const issue = (message: string, path: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if ((s.status === 'not_eligible') !== (s.ineligibleReason !== null))
        issue(
          'ineligibleReason is set exactly when the reader is not eligible',
          'ineligibleReason',
        );
      const joined = s.status === 'joined';
      if (joined !== (s.joinedAt !== null))
        issue('joinedAt is set exactly when joined', 'joinedAt');
      if (joined !== (s.modelVersion !== null))
        issue('modelVersion is set exactly when joined', 'modelVersion');
      if (joined ? s.heldOut.length === 0 : s.heldOut.length > 0)
        issue('held-out books are shown only once joined', 'heldOut');
    }),
);

export type Study = z.infer<typeof studySchema>;

export const studyJoinSchema = requestSchema(
  'StudyJoin',
  z.object({
    consent: z.literal(true, { error: 'Agree to take part to join the study.' }),
  }),
);
