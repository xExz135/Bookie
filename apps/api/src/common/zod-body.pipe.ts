import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './api-error';

/**
 * Validates a request body with a zod schema. Problems come back as
 * VALIDATION_FAILED with one message per field (CONTRACT section 2).
 */
export class ZodBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    return parseBody(this.schema, value);
  }
}

/** Same as the pipe, for schemas built at runtime (for example from configured limits). */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    fields[field] ??= issue.message;
  }
  throw new ApiError('VALIDATION_FAILED', { fields });
}
