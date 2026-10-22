import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { signAccessToken } from '../../src/auth/tokens';
import type { AppConfig } from '../../src/config/app-config';
import { buildOpenApiDocument } from '../../src/openapi/document';
import { createTestApp, type FakeMailer, uniqueEmail } from './test-app';
import { TEST_DATABASE_URL } from './test-database';

const PASSWORD = 'correct horse battery';

/** The refresh cookie from a response, as "name=value", plus its attributes. */
function refreshCookie(res: request.Response): { pair: string; attributes: string } {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = raw.find((c) => c.startsWith('bookie_refresh='));
  if (!line) throw new Error('no refresh cookie set');
  const [pair, ...attributes] = line.split(';').map((s) => s.trim());
  return { pair: pair!, attributes: attributes.join('; ') };
}

describe('authentication (BE-3, D-001)', () => {
  let app: NestExpressApplication;
  let config: AppConfig;
  let mailer: FakeMailer;
  let db: Client;
  const http = () => request(app.getHttpServer());

  const register = (email: string, password = PASSWORD) =>
    http().post('/api/v1/auth/register').send({ email, password, displayName: 'Ada' });

  beforeAll(async () => {
    ({ app, config, mailer } = await createTestApp());
    db = new Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  describe('register', () => {
    it('creates the account and signs in right away', async () => {
      const email = uniqueEmail('Reg');
      const res = await register(`  ${email.toUpperCase()} `).expect(201);
      expect(res.body).toEqual({
        accessToken: expect.any(String),
        expiresInSeconds: config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: expect.any(String),
          email: email.toLowerCase(),
          displayName: 'Ada',
          onboardingState: 'pending',
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);

      const { attributes } = refreshCookie(res);
      expect(attributes).toContain('HttpOnly');
      expect(attributes).toContain('Secure');
      expect(attributes).toContain('SameSite=Lax');
      expect(attributes).toContain('Path=/api/v1/auth');
    });

    it('stores an argon2id hash, never the password', async () => {
      const email = uniqueEmail('hash');
      await register(email).expect(201);
      const { rows } = await db.query('SELECT password_hash FROM users WHERE email = $1', [email]);
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0].password_hash).not.toContain(PASSWORD);
    });

    it('returns EMAIL_IN_USE for a taken email, whatever its case (D-001)', async () => {
      const email = uniqueEmail('dup');
      await register(email).expect(201);
      const res = await register(email.toUpperCase()).expect(409);
      expect(res.body).toMatchObject({ code: 'EMAIL_IN_USE' });
    });

    it('rejects invalid input field by field', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'short', displayName: '  ' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.fields).sort()).toEqual(['displayName', 'email', 'password']);
      expect(res.body.fields.password).toContain(String(config.AUTH_PASSWORD_MIN_LENGTH));
    });

    it('rejects a password longer than the maximum', async () => {
      const res = await register(
        uniqueEmail('long'),
        'x'.repeat(config.AUTH_PASSWORD_MAX_LENGTH + 1),
      ).expect(400);
      expect(res.body.fields).toHaveProperty('password');
    });

    it('rejects a body that is not JSON', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('login', () => {
    it('signs in with the right password', async () => {
      const email = uniqueEmail('login');
      await register(email).expect(201);
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: email.toUpperCase(), password: PASSWORD })
        .expect(200);
      expect(res.body.user.email).toBe(email);
      refreshCookie(res);
    });

    it('answers a wrong password and an unknown email identically', async () => {
      const email = uniqueEmail('same');
      await register(email).expect(201);
      const wrong = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong password!' })
        .expect(401);
      const unknown = await http()
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail('nobody'), password: PASSWORD })
        .expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('access tokens and the guard (SEC-2)', () => {
    it('GET /me returns the signed-in reader only (SEC-1)', async () => {
      const email = uniqueEmail('me');
      const { body } = await register(email).expect(201);
      const res = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(res.body).toEqual(body.user);
    });

    it('rejects a missing, malformed or forged token with UNAUTHENTICATED', async () => {
      const forged = signAccessToken(
        { id: '00000000-0000-4000-8000-000000000000', tokenVersion: 0 },
        'z'.repeat(64),
        900,
      );
      for (const header of [
        undefined,
        'Bearer',
        'Basic abc',
        'Bearer not.a.token',
        `Bearer ${forged}`,
      ]) {
        const req = http().get('/api/v1/me');
        if (header) req.set('Authorization', header);
        const res = await req.expect(401);
        expect(res.body.code).toBe('UNAUTHENTICATED');
      }
    });

    it('reports an expired token as TOKEN_EXPIRED so the client refreshes once', async () => {
      const { body } = await register(uniqueEmail('exp')).expect(201);
      const expired = signAccessToken(
        { id: body.user.id, tokenVersion: 0 },
        config.AUTH_TOKEN_SECRET,
        60,
        Date.now() - 120_000,
      );
      const res = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects a valid token once its user is deleted', async () => {
      const { body } = await register(uniqueEmail('gone')).expect(201);
      await db.query('DELETE FROM users WHERE id = $1', [body.user.id]);
      const res = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('refresh and logout', () => {
    it('rotates the refresh token: the new one works, the old one is revoked', async () => {
      const first = refreshCookie(await register(uniqueEmail('rot')).expect(201));

      const refreshed = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', first.pair)
        .expect(200);
      expect(refreshed.body).toEqual({
        accessToken: expect.any(String),
        expiresInSeconds: config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      });
      const second = refreshCookie(refreshed);
      expect(second.pair).not.toBe(first.pair);
      await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
        .expect(200);

      const reused = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', first.pair)
        .expect(401);
      expect(reused.body.code).toBe('UNAUTHENTICATED');
      await http().post('/api/v1/auth/refresh').set('Cookie', second.pair).expect(200);
    });

    it('stores refresh tokens only as SHA-256 hashes', async () => {
      const res = await register(uniqueEmail('rhash')).expect(201);
      const raw = decodeURIComponent(refreshCookie(res).pair.split('=')[1]!);
      const { rows } = await db.query('SELECT token_hash FROM refresh_tokens WHERE user_id = $1', [
        res.body.user.id,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].token_hash).not.toBe(raw);
    });

    it('refuses to refresh without a cookie, or with an expired one', async () => {
      const none = await http().post('/api/v1/auth/refresh').expect(401);
      expect(none.body.code).toBe('UNAUTHENTICATED');

      const res = await register(uniqueEmail('rexp')).expect(201);
      // An hour, not a second: the database clock (Docker) can drift a second or
      // more from the API's, which checks expiry with its own clock.
      await db.query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
        [res.body.user.id],
      );
      await http().post('/api/v1/auth/refresh').set('Cookie', refreshCookie(res).pair).expect(401);
    });

    it('logout revokes the refresh token and clears the cookie', async () => {
      const { pair } = refreshCookie(await register(uniqueEmail('out')).expect(201));
      const out = await http().post('/api/v1/auth/logout').set('Cookie', pair).expect(204);
      expect(([] as string[]).concat(out.headers['set-cookie'] ?? []).join()).toMatch(
        /bookie_refresh=;.*Expires=Thu, 01 Jan 1970/,
      );
      await http().post('/api/v1/auth/refresh').set('Cookie', pair).expect(401);
      // Logging out twice, or without a cookie, still succeeds.
      await http().post('/api/v1/auth/logout').set('Cookie', pair).expect(204);
      await http().post('/api/v1/auth/logout').expect(204);
    });
  });

  describe('forgot and reset password', () => {
    const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

    it('answers the same for known and unknown emails', async () => {
      const email = uniqueEmail('fp');
      await register(email).expect(201);
      const known = await http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const unknown = await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: uniqueEmail('fp-nobody') })
        .expect(202);
      expect(known.body).toEqual(unknown.body);
      expect(known.text).toBe(unknown.text);
    });

    it('resets with a single-use link and ends every session', async () => {
      const email = uniqueEmail('reset');
      const signedUp = await register(email).expect(201);
      const oldCookie = refreshCookie(signedUp).pair;

      await http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const mail = await mailer.waitFor(email);
      expect(mail.text).toContain(`${config.WEB_ORIGIN}/reset-password#token=`);
      const token = tokenFrom(mail.text);

      const { rows } = await db.query(
        'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
        [signedUp.body.user.id],
      );
      expect(rows[0].token_hash).not.toBe(token);

      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'a brand new password' })
        .expect(204);

      // Old password out, new password in.
      await http().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(401);
      await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'a brand new password' })
        .expect(200);

      // Every earlier session ends: refresh token and access token.
      await http().post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(401);
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${signedUp.body.accessToken}`)
        .expect(401);
      expect(me.body.code).toBe('UNAUTHENTICATED');

      // The link works once.
      const again = await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'yet another password' })
        .expect(400);
      expect(again.body.fields).toHaveProperty('token');
    });

    it('rejects an expired link', async () => {
      const email = uniqueEmail('rlate');
      const res = await register(email).expect(201);
      await http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
      const token = tokenFrom((await mailer.waitFor(email)).text);
      await db.query(
        // An hour: see the expired refresh token above (clock drift).
        `UPDATE password_reset_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
        [res.body.user.id],
      );
      const late = await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'a brand new password' })
        .expect(400);
      expect(late.body.fields).toHaveProperty('token');
    });

    it('rejects a made-up link and a too-short new password', async () => {
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: 'made-up', newPassword: 'a brand new password' })
        .expect(400);
      const short = await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: 'made-up', newPassword: 'short' })
        .expect(400);
      expect(short.body.fields).toHaveProperty('newPassword');
    });
  });
});

describe('throttling (D-001)', () => {
  it('limits login per email and per IP, with Retry-After', async () => {
    const { app } = await createTestApp({ RATE_LIMIT_AUTH_MAX: '3' });
    try {
      const email = uniqueEmail('throttle');
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: 'wrong password!' })
          .expect(401);
      }
      const blocked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong password!' })
        .expect(429);
      expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.headers['retry-after']).toBe(String(blocked.body.retryAfterSeconds));

      // Same IP, different email: the per-IP counter is also used up.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail('other'), password: 'wrong password!' })
        .expect(429);
      // Other actions have their own counters.
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(202);
    } finally {
      await app.close();
    }
  });

  it('keeps throttling in memory when Redis is down (spec 10)', async () => {
    const { app } = await createTestApp({
      RATE_LIMIT_AUTH_MAX: '2',
      REDIS_URL: 'redis://localhost:1',
    });
    try {
      const email = uniqueEmail('noredis');
      const started = Date.now();
      for (let i = 0; i < 2; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/forgot-password')
          .send({ email })
          .expect(202);
      }
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(429);
      // Fails fast instead of waiting on Redis for every request.
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await app.close();
    }
  });
});

describe('SEC-2: no endpoint except sign-in is reachable without authentication', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('every operation that is not under /auth requires a token, and answers 401 without one', async () => {
    const doc = buildOpenApiDocument(app);
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { security?: unknown[] }>).map(([method, op]) => ({
        path,
        method,
        isPublic: Array.isArray(op.security) && op.security.length === 0,
      })),
    );
    expect(operations.length).toBeGreaterThan(0);

    for (const op of operations) {
      if (op.isPublic) {
        expect(op.path).toMatch(/^\/api\/v1\/auth\//);
        continue;
      }
      const url = op.path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
      const res = await (
        request(app.getHttpServer()) as unknown as Record<string, (url: string) => request.Test>
      )[op.method]!(url);
      expect({ op: `${op.method} ${op.path}`, status: res.status, code: res.body.code }).toEqual({
        op: `${op.method} ${op.path}`,
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('@Public() is used only by the auth and health controllers', () => {
    const allowed = new Set(['src/auth/auth.controller.ts', 'src/health/health.controller.ts']);
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'generated') walk(path);
        } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
          const file = relative(root, path).replace(/\\/g, '/');
          // Decorator lines only, not mentions in comments.
          if (/^\s*@Public\(\)/m.test(readFileSync(path, 'utf8')) && !allowed.has(file)) {
            offenders.push(file);
          }
        }
      }
    };
    walk(join(root, 'src'));
    expect(offenders).toEqual([]);
  });
});
