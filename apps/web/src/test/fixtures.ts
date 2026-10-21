import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonBodyType } from 'msw';

/**
 * Contract fixtures (contract/fixtures/): the same files the backend's
 * contract test checks against the API, so mocks cannot drift from it.
 */
interface Outcome {
  status: number;
  body: JsonBodyType;
}

const DIR = join(__dirname, '..', '..', '..', '..', 'contract', 'fixtures');

export function fixture(file: string, outcome: string): Outcome {
  const data = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as {
    outcomes: Record<string, Outcome>;
  };
  const found = data.outcomes[outcome];
  if (!found) throw new Error(`${file} has no outcome "${outcome}"`);
  return found;
}
