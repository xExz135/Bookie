import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Access tokens are compact JWTs signed with HMAC-SHA256 (D-001). Only this
 * one algorithm is accepted, so a token cannot choose a weaker one ("none").
 */
const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export interface AccessClaims {
  /** User id. */
  sub: string;
  /** The user's token version when the token was issued (see users.token_version). */
  ver: number;
  /** Issued and expiry times, in seconds since the epoch. */
  iat: number;
  exp: number;
}

export type VerifyResult =
  { ok: true; claims: AccessClaims } | { ok: false; reason: 'invalid' | 'expired' };

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signAccessToken(
  user: { id: string; tokenVersion: number },
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: AccessClaims = { sub: user.id, ver: user.tokenVersion, iat, exp: iat + ttlSeconds };
  const body = `${HEADER}.${base64url(JSON.stringify(claims))}`;
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

export function verifyAccessToken(token: string, secret: string, nowMs = Date.now()): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: 'invalid' };
  const [header, payload, signature] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`, secret);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    typeof claims.sub !== 'string' ||
    !Number.isInteger(claims.ver) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (claims.exp <= Math.floor(nowMs / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** A random token for refresh cookies and reset links. Only its hash is stored. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a random token, as stored in the database (D-001). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Rate-limit keys use a hash so Redis never holds an email address. */
export function hashForKey(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22);
}
