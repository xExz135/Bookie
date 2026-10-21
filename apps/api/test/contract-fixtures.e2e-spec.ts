import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { loadConfig } from '../src/config/app-config';
import {
  DEFAULT_MESSAGES,
  ERROR_CODES,
  type ErrorCode,
  RETRYABLE,
} from '../src/contract/error-codes';
import { registeredSchema } from '../src/openapi/contract-schemas';
import { buildOpenApiDocument } from '../src/openapi/document';

/**
 * CONTRACT 1: every endpoint has a fixture per outcome, and the frontend
 * mocks use the same files. This checks the fixtures against the API itself.
 */
interface Outcome {
  status: number;
  schema?: string;
  body: unknown;
}
interface Fixture {
  file: string;
  endpoint: string;
  /**
   * The work package that will build this endpoint. A planned fixture
   * publishes the agreed shape before the endpoint exists (contract first);
   * its bodies are checked like any other.
   */
  planned?: string;
  outcomes: Record<string, Outcome>;
}

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'contract', 'fixtures');

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      ...(JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as Omit<Fixture, 'file'>),
    }));
}

describe('contract fixtures', () => {
  let app: INestApplication;
  let operations: Array<{ endpoint: string; statuses: number[] }>;
  const fixtures = loadFixtures();

  beforeAll(async () => {
    app = await createApp(loadConfig({ NODE_ENV: 'test' }), { logger: false });
    await app.init();
    const doc = buildOpenApiDocument(app);
    operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { responses: Record<string, unknown> }>).map(
        ([method, op]) => ({
          endpoint: `${method.toUpperCase()} ${path}`,
          statuses: Object.keys(op.responses).map(Number),
        }),
      ),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('every endpoint has a fixture covering each documented status, and nothing undocumented', () => {
    const byEndpoint = new Map(fixtures.map((f) => [f.endpoint, f]));
    const problems: string[] = [];
    for (const op of operations) {
      const fixture = byEndpoint.get(op.endpoint);
      if (!fixture) {
        problems.push(`${op.endpoint}: no fixture`);
        continue;
      }
      const covered = new Set(Object.values(fixture.outcomes).map((o) => o.status));
      for (const status of op.statuses) {
        if (!covered.has(status)) problems.push(`${op.endpoint}: no outcome for ${status}`);
      }
      for (const status of covered) {
        if (!op.statuses.includes(status)) {
          problems.push(`${op.endpoint}: outcome ${status} is not documented in openapi.json`);
        }
      }
    }
    for (const fixture of fixtures) {
      const exists = operations.some((op) => op.endpoint === fixture.endpoint);
      if (!exists && !fixture.planned) {
        problems.push(`${fixture.file}: endpoint ${fixture.endpoint} does not exist`);
      }
      if (exists && fixture.planned) {
        problems.push(`${fixture.file}: the endpoint exists now; remove "planned"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('success bodies match their schema exactly', () => {
    const problems: string[] = [];
    for (const fixture of fixtures) {
      for (const [name, outcome] of Object.entries(fixture.outcomes)) {
        if (outcome.status >= 400) continue;
        if (!outcome.schema) {
          if (outcome.body !== null) problems.push(`${fixture.file} ${name}: body must be null`);
          continue;
        }
        const schema = registeredSchema(outcome.schema);
        if (!schema) {
          problems.push(`${fixture.file} ${name}: unknown schema ${outcome.schema}`);
          continue;
        }
        const parsed = schema.safeParse(outcome.body);
        if (!parsed.success) {
          problems.push(`${fixture.file} ${name}: ${parsed.error.issues[0]?.message}`);
        } else if (JSON.stringify(parsed.data) !== JSON.stringify(outcome.body)) {
          problems.push(`${fixture.file} ${name}: has fields the schema does not define`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('error bodies use contract codes with their status, message and retryable flag', () => {
    const problems: string[] = [];
    for (const fixture of fixtures) {
      for (const [name, outcome] of Object.entries(fixture.outcomes)) {
        if (outcome.status < 400) continue;
        const body = outcome.body as Record<string, unknown>;
        const code = body.code as ErrorCode;
        const where = `${fixture.file} ${name}`;
        if (!(code in ERROR_CODES)) {
          problems.push(`${where}: unknown code ${String(code)}`);
          continue;
        }
        if (ERROR_CODES[code] !== outcome.status)
          problems.push(`${where}: wrong status for ${code}`);
        if (body.message !== DEFAULT_MESSAGES[code]) problems.push(`${where}: message differs`);
        if (body.retryable !== RETRYABLE.has(code)) problems.push(`${where}: retryable differs`);
        if ('fields' in body !== (code === 'VALIDATION_FAILED')) {
          problems.push(`${where}: fields only belong to VALIDATION_FAILED`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
