import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../repo-root';
import { type Analysis, analysisSchema } from './analysis.schemas';

/**
 * The Analysis schema carries the CONTRACT 4.4 meaning rules, so a response
 * that breaks one fails validation. Each case starts from a valid fixture and
 * breaks one rule.
 */
const fixture = JSON.parse(
  readFileSync(join(findRepoRoot(), 'contract', 'fixtures', 'analyses-get.json'), 'utf8'),
) as { outcomes: Record<string, { body: Analysis }> };

const sample = (name: string): Analysis => structuredClone(fixture.outcomes[name]!.body);

function problems(analysis: unknown): string[] {
  const result = analysisSchema.safeParse(analysis);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('Analysis schema (CONTRACT 4.4)', () => {
  it('accepts every analysis fixture', () => {
    for (const [name, outcome] of Object.entries(fixture.outcomes)) {
      if ('code' in (outcome.body as object)) continue;
      expect([name, problems(outcome.body)]).toEqual([name, []]);
    }
  });

  it('RES-5: rejects a citation to evidence that is not in the response', () => {
    const a = sample('complete');
    a.publicReception.evidence = a.publicReception.evidence.slice(1);
    expect(problems(a).join()).toMatch(/is cited but not included/);
  });

  it('RES-3: rejects a written verdict when evidence is insufficient', () => {
    const a = sample('insufficientEvidence');
    a.publicReception.summary = 'Readers loved it.';
    expect(problems(a)).toContain('no summary when evidence is insufficient or unavailable');
  });

  it('RES-4: all sources failed is a failed analysis, never partial', () => {
    const a = sample('allSourcesFailed');
    a.status = 'partial';
    expect(problems(a)).toContain('all sources failed means the analysis failed');
  });

  it('MODEL-4: no score below the floor', () => {
    const a = sample('belowFloor');
    a.personalMatch.score = 3.5;
    expect(problems(a)).toContain('score is set exactly when status is done');
  });

  it('D-010: the score is on the 1 to 5 scale with one decimal, never a percentage', () => {
    const a = sample('complete');
    a.personalMatch.score = 84;
    expect(problems(a).length).toBeGreaterThan(0);
    a.personalMatch.score = 4.25;
    expect(problems(a)).toContain('score has one decimal');
  });

  it('MODEL-3: a score records its model and version', () => {
    const a = sample('complete');
    a.personalMatch.modelVersion = null;
    expect(problems(a)).toContain('a score records its model, version and confidence (MODEL-3)');
  });

  it('a fallback model is labelled with low confidence', () => {
    const a = sample('fallbackModel');
    a.personalMatch.evidenceConfidence = { level: 'high', reasons: [] };
    expect(problems(a)).toContain('a fallback score has low confidence');
  });

  it('RES-2: lists all eight steps in order, with an error code only on failed ones', () => {
    const a = sample('complete');
    a.steps = a.steps.slice(0, 7);
    expect(problems(a)).toContain('steps must list all eight steps in stepName order');
    const b = sample('personalFailed');
    b.steps.find((s) => s.name === 'personalMatch')!.errorCode = null;
    expect(problems(b).join()).toMatch(/errorCode is set exactly when the step failed/);
  });

  it('feedback only on sections that were generated', () => {
    const a = sample('belowFloor');
    a.feedback.personal = 'accurate';
    expect(problems(a)).toContain('no personal feedback without a score');
  });

  it('excerpts are withheld where the source does not allow display', () => {
    const a = sample('complete');
    a.publicReception.evidence[1]!.displayAllowed = false;
    expect(problems(a)).toContain('excerpt must be null when display is not allowed');
  });

  it('has no combined score or verdict field (D-010)', () => {
    const a = { ...sample('complete'), verdict: 'Highly recommended', overallScore: 4.3 };
    const parsed = analysisSchema.parse(a);
    expect(parsed).not.toHaveProperty('verdict');
    expect(parsed).not.toHaveProperty('overallScore');
  });
});
