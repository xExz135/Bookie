import { z } from 'zod';

/**
 * Request and response shapes are written once, as zod schemas. The same
 * schema validates requests at runtime and is published in
 * contract/openapi.json under its name, so the two cannot drift apart.
 */
const registry = new Map<string, { schema: z.ZodType; io: 'input' | 'output' }>();

/** Registers a request body schema (published as the input shape). */
export function requestSchema<T extends z.ZodType>(name: string, schema: T): T {
  registry.set(name, { schema, io: 'input' });
  return schema;
}

/** Registers a response body schema (published as the output shape). */
export function responseSchema<T extends z.ZodType>(name: string, schema: T): T {
  registry.set(name, { schema, io: 'output' });
  return schema;
}

/** A registered schema by name (used by the contract fixture test). */
export function registeredSchema(name: string): z.ZodType | undefined {
  return registry.get(name)?.schema;
}

/** A JSON reference to a registered schema, for @ApiBody and @ApiResponse. */
export function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

/** The registered schemas as OpenAPI 3.0 component schemas. */
export function registeredComponentSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, { schema, io }] of registry) {
    const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as Record<string, unknown>;
    delete json.$schema;
    out[name] = json;
  }
  return out;
}
