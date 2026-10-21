/**
 * Shared enums from docs/CONTRACT.md section 3. Both roles use these values.
 * A test checks they match the contract document exactly.
 */
export const CONTRACT_ENUMS = {
  analysisStatus: ['running', 'complete', 'partial', 'failed'],
  stepName: [
    'resolve',
    'fetchReviews',
    'selectReviews',
    'extractTraits',
    'publicSummary',
    'evidenceConfidence',
    'personalMatch',
    'finalize',
  ],
  stepStatus: ['pending', 'running', 'done', 'failed', 'skipped'],
  sourceOutcome: ['ok', 'empty', 'failed', 'rate_limited', 'not_permitted'],
  evidenceState: ['sufficient', 'limited', 'insufficient', 'unavailable'],
  confidenceLevel: ['low', 'medium', 'high'],
  personalMatchStatus: ['done', 'running', 'failed', 'skipped', 'needs_taste_data', 'below_floor'],
  feedbackTarget: ['public', 'personal'],
  feedbackValue: ['accurate', 'not_for_me'],
  traitKey: ['pace', 'tone', 'themes', 'contentIntensity'],
  traitFit: ['aligned', 'conflicting', 'unknown'],
  modelId: ['B0', 'B1', 'B2', 'B3', 'B4'],
  readingListGroup: ['ranked', 'low_confidence', 'no_match'],
} as const;

export type ContractEnumName = keyof typeof CONTRACT_ENUMS;
export type ContractEnum<N extends ContractEnumName> = (typeof CONTRACT_ENUMS)[N][number];

export type AnalysisStatus = ContractEnum<'analysisStatus'>;
export type StepName = ContractEnum<'stepName'>;
export type StepStatus = ContractEnum<'stepStatus'>;
export type SourceOutcome = ContractEnum<'sourceOutcome'>;
export type EvidenceState = ContractEnum<'evidenceState'>;
export type ConfidenceLevel = ContractEnum<'confidenceLevel'>;
export type PersonalMatchStatus = ContractEnum<'personalMatchStatus'>;
export type FeedbackTarget = ContractEnum<'feedbackTarget'>;
export type FeedbackValue = ContractEnum<'feedbackValue'>;
export type TraitKey = ContractEnum<'traitKey'>;
export type TraitFit = ContractEnum<'traitFit'>;
export type ModelId = ContractEnum<'modelId'>;
export type ReadingListGroup = ContractEnum<'readingListGroup'>;
