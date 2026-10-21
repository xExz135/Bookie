import { createHmac } from 'node:crypto';
import { hashToken, randomToken, signAccessToken, verifyAccessToken } from './tokens';

const SECRET = 'a'.repeat(64);
const user = { id: '7f1b5a8e-6a43-4bfa-9c39-2f6e0a1b2c3d', tokenVersion: 3 };

describe('access tokens (D-001)', () => {
  it('round-trips the user id and token version', () => {
    const token = signAccessToken(user, SECRET, 900, 1_000_000);
    const result = verifyAccessToken(token, SECRET, 1_000_000 + 1000);
    expect(result).toEqual({
      ok: true,
      claims: { sub: user.id, ver: 3, iat: 1000, exp: 1900 },
    });
  });

  it('reports an expired token as expired, not invalid', () => {
    const token = signAccessToken(user, SECRET, 900, 1_000_000);
    expect(verifyAccessToken(token, SECRET, 1_000_000 + 900_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a token signed with another secret', () => {
    const token = signAccessToken(user, 'b'.repeat(64), 900);
    expect(verifyAccessToken(token, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token whose claims were changed', () => {
    const [header, , signature] = signAccessToken(user, SECRET, 900).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', ver: 3, iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(verifyAccessToken(`${header}.${forged}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects the "none" algorithm and any other header', () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: user.id, ver: 3, iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyAccessToken(`${none}.${payload}.`, SECRET).ok).toBe(false);

    // Correctly signed, but with a header this API never issues.
    const hs512 = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${hs512}.${payload}`).digest('base64url');
    expect(verifyAccessToken(`${hs512}.${payload}.${sig}`, SECRET).ok).toBe(false);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '...']) {
      expect(verifyAccessToken(bad, SECRET).ok).toBe(false);
    }
  });
});

describe('stored tokens (D-001)', () => {
  it('random tokens are long and unique', () => {
    const tokens = new Set(Array.from({ length: 100 }, randomToken));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it('only a SHA-256 hash is stored', () => {
    const token = randomToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});
