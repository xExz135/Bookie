import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config/app-config';

/** Refresh token cookie (D-001, CONTRACT 2). Sent only to the auth endpoints. */
export const REFRESH_COOKIE = 'bookie_refresh';
const COOKIE_PATH = '/api/v1/auth';

function options(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, token: string, config: AppConfig): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...options(config),
    maxAge: config.AUTH_REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearRefreshCookie(res: Response, config: AppConfig): void {
  res.clearCookie(REFRESH_COOKIE, options(config));
}

/** Reads the refresh cookie from the Cookie header. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
