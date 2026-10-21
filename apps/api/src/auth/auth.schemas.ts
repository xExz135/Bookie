import { z } from 'zod';
import type { AppConfig } from '../config/app-config';
import { requestSchema, responseSchema } from '../openapi/contract-schemas';

/** CONTRACT 4.1. Shapes are published in contract/openapi.json under these names. */

export const ONBOARDING_STATES = ['pending', 'skipped', 'completed'] as const;

export const userSchema = responseSchema(
  'User',
  z.object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
    onboardingState: z.enum(ONBOARDING_STATES),
  }),
);

export const accessTokenSchema = responseSchema(
  'AccessToken',
  z.object({
    accessToken: z.string(),
    expiresInSeconds: z.int().positive(),
  }),
);

export const authSessionSchema = responseSchema(
  'AuthSession',
  z.object({
    accessToken: z.string(),
    expiresInSeconds: z.int().positive(),
    user: userSchema,
  }),
);

export type UserView = z.infer<typeof userSchema>;
export type AccessTokenView = z.infer<typeof accessTokenSchema>;
export type AuthSessionView = z.infer<typeof authSessionSchema>;

/** Request schemas depend on configured limits (password length and so on). */
export function authRequestSchemas(config: AppConfig) {
  const min = config.AUTH_PASSWORD_MIN_LENGTH;
  const max = config.AUTH_PASSWORD_MAX_LENGTH;

  const email = z
    .string({ error: 'Enter your email.' })
    .trim()
    .toLowerCase()
    .min(1, 'Enter your email.')
    .max(254, 'This email is too long.');
  const newPassword = z
    .string({ error: 'Enter a password.' })
    .min(min, `Use at least ${min} characters.`)
    .max(max, `Use at most ${max} characters.`);

  return {
    register: requestSchema(
      'RegisterRequest',
      z.object({
        email: email.regex(z.regexes.email, 'Enter a valid email.'),
        password: newPassword,
        displayName: z
          .string({ error: 'Enter a display name.' })
          .trim()
          .min(1, 'Enter a display name.')
          .max(
            config.AUTH_DISPLAY_NAME_MAX_LENGTH,
            `Use at most ${config.AUTH_DISPLAY_NAME_MAX_LENGTH} characters.`,
          )
          // Control characters (C0, DEL, C1), written so any regex engine accepts it.
          .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, 'Remove control characters.'),
      }),
    ),
    login: requestSchema(
      'LoginRequest',
      z.object({
        email,
        // Only the upper bound is checked here, to cap hashing work.
        password: z
          .string({ error: 'Enter your password.' })
          .min(1, 'Enter your password.')
          .max(max, `Use at most ${max} characters.`),
      }),
    ),
    forgotPassword: requestSchema('ForgotPasswordRequest', z.object({ email })),
    resetPassword: requestSchema(
      'ResetPasswordRequest',
      z.object({
        token: z
          .string({ error: 'The reset link is invalid.' })
          .min(1, 'The reset link is invalid.')
          .max(200, 'The reset link is invalid.'),
        newPassword,
      }),
    ),
  };
}

export type AuthRequests = ReturnType<typeof authRequestSchemas>;
export type RegisterRequest = z.output<AuthRequests['register']>;
export type LoginRequest = z.output<AuthRequests['login']>;
export type ForgotPasswordRequest = z.output<AuthRequests['forgotPassword']>;
export type ResetPasswordRequest = z.output<AuthRequests['resetPassword']>;
