import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PARAMS } from './params';

type Shape = { [K in keyof typeof PARAMS]: (typeof PARAMS)[K]['schema'] };

const shape = Object.fromEntries(
  Object.entries(PARAMS).map(([key, def]) => [key, def.schema]),
) as Shape;

export const configSchema = z.object(shape).superRefine((cfg, ctx) => {
  if (cfg.TASTE_HARD_FLOOR > cfg.TASTE_MIN_RATED_FOR_CONFIDENCE) {
    ctx.addIssue({
      code: 'custom',
      path: ['TASTE_HARD_FLOOR'],
      message: 'must not be greater than TASTE_MIN_RATED_FOR_CONFIDENCE',
    });
  }
  if (cfg.AUTH_PASSWORD_MIN_LENGTH > cfg.AUTH_PASSWORD_MAX_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_PASSWORD_MIN_LENGTH'],
      message: 'must not be greater than AUTH_PASSWORD_MAX_LENGTH',
    });
  }
  if (cfg.NODE_ENV === 'production' && !cfg.AUTH_TOKEN_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_TOKEN_SECRET'],
      message: 'is required in production',
    });
  }
});

export type AppConfig = Omit<z.infer<typeof configSchema>, 'AUTH_TOKEN_SECRET'> & {
  AUTH_TOKEN_SECRET: string;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads and validates settings. Empty strings count as "not set" so a copied
 * .env.example with blank lines falls back to defaults. Error messages name the
 * setting but never echo its value, so secrets cannot leak into logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const input: Record<string, string> = {};
  for (const key of Object.keys(PARAMS)) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') input[key] = value.trim();
  }

  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  return {
    ...result.data,
    AUTH_TOKEN_SECRET: result.data.AUTH_TOKEN_SECRET ?? randomBytes(32).toString('hex'),
  };
}
