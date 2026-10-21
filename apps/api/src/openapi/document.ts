import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/error-response.dto';
import { CONTRACT_ENUMS } from '../contract/enums';
import { registeredComponentSchemas } from './contract-schemas';

/** Matches the status line of docs/CONTRACT.md. */
export const CONTRACT_VERSION = '0.2.0-draft';

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Recursively sorts object keys so the generated file is stable in diffs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Builds contract/openapi.json from the running app's controllers and DTOs. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('Book Verdict API')
    .setDescription(
      'Generated from apps/api. Meanings and rules live in docs/CONTRACT.md; this file holds shapes.',
    )
    .setVersion(CONTRACT_VERSION)
    .addBearerAuth()
    // Every operation needs the access token unless it says `security: []` (SEC-2).
    .addSecurityRequirements('bearer')
    .build();

  const document = SwaggerModule.createDocument(app, options, { extraModels: [ErrorResponseDto] });
  document.components ??= {};
  document.components.schemas ??= {};
  Object.assign(document.components.schemas, registeredComponentSchemas());
  for (const [name, values] of Object.entries(CONTRACT_ENUMS)) {
    document.components.schemas[pascal(name)] = { type: 'string', enum: [...values] };
  }
  return sortKeys(document) as OpenAPIObject;
}
