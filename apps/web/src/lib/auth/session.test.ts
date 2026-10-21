import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { fixture } from '@/test/fixtures';
import { server } from '@/test/server';
import { Session } from './session';

const API = 'http://api.test';
const refreshed = fixture('auth-refresh.json', 'success').body as { accessToken: string };
const expired = fixture('me.json', 'tokenExpired');
const unauthenticated = fixture('me.json', 'unauthenticated');
const me = fixture('me.json', 'success');

function newSession(locks?: Pick<LockManager, 'request'>) {
  return new Session({ apiUrl: API, fetch: (...args) => globalThis.fetch(...args), locks });
}

/** /me answers 200 only for the refreshed token, TOKEN_EXPIRED otherwise. Counts refreshes. */
function serveRefreshAndMe() {
  const counts = { refresh: 0, me: 0 };
  server.use(
    http.post(`${API}/api/v1/auth/refresh`, () => {
      counts.refresh++;
      return HttpResponse.json(refreshed);
    }),
    http.get(`${API}/api/v1/me`, ({ request }) => {
      counts.me++;
      return request.headers.get('authorization') === `Bearer ${refreshed.accessToken}`
        ? HttpResponse.json(me.body)
        : HttpResponse.json(expired.body, { status: expired.status });
    }),
  );
  return counts;
}

describe('session and silent refresh (CONTRACT 2)', () => {
  it('sends the access token as a bearer header', async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${API}/api/v1/me`, ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json(me.body);
      }),
    );
    const session = newSession();
    session.setAccessToken('abc.def.ghi');
    await session.fetch(new Request(`${API}/api/v1/me`));
    expect(seen).toBe('Bearer abc.def.ghi');
  });

  it('on TOKEN_EXPIRED refreshes once and retries once, keeping the request body', async () => {
    const bodies: unknown[] = [];
    let refreshes = 0;
    server.use(
      http.post(`${API}/api/v1/auth/refresh`, () => {
        refreshes++;
        return HttpResponse.json(refreshed);
      }),
      http.put(`${API}/api/v1/ratings/x`, async ({ request }) => {
        bodies.push(await request.json());
        return request.headers.get('authorization') === `Bearer ${refreshed.accessToken}`
          ? HttpResponse.json({ tasteProfileVersion: 1, ratedCount: 1 })
          : HttpResponse.json(expired.body, { status: 401 });
      }),
    );
    const session = newSession();
    session.setAccessToken('old-token');
    const res = await session.fetch(
      new Request(`${API}/api/v1/ratings/x`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 4 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(refreshes).toBe(1);
    expect(bodies).toEqual([{ rating: 4 }, { rating: 4 }]);
    expect(session.accessToken).toBe(refreshed.accessToken);
  });

  it('shares one refresh between calls that expire at the same time', async () => {
    const counts = serveRefreshAndMe();
    const session = newSession();
    session.setAccessToken('old-token');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => session.fetch(new Request(`${API}/api/v1/me`))),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(counts.refresh).toBe(1);
  });

  it('holds a Web Lock while refreshing, so tabs do not refresh at the same time', async () => {
    serveRefreshAndMe();
    const request = vi.fn((_name: string, run: () => Promise<boolean>) => run());
    const session = newSession({ request } as unknown as Pick<LockManager, 'request'>);
    expect(await session.refresh()).toBe(true);
    expect(request).toHaveBeenCalledWith('bookie-auth-refresh', expect.any(Function));
  });

  it('ends the session when the refresh fails, and returns the original 401', async () => {
    const noCookie = fixture('auth-refresh.json', 'noValidRefreshCookie');
    server.use(
      http.post(`${API}/api/v1/auth/refresh`, () =>
        HttpResponse.json(noCookie.body, { status: noCookie.status }),
      ),
      http.get(`${API}/api/v1/me`, () => HttpResponse.json(expired.body, { status: 401 })),
    );
    const session = newSession();
    const ended = vi.fn();
    session.onExpired(ended);
    session.setAccessToken('old-token');
    const res = await session.fetch(new Request(`${API}/api/v1/me`));
    expect(res.status).toBe(401);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(session.accessToken).toBeNull();
  });

  it('ends the session on UNAUTHENTICATED (for example after a password reset elsewhere)', async () => {
    server.use(
      http.get(`${API}/api/v1/me`, () =>
        HttpResponse.json(unauthenticated.body, { status: unauthenticated.status }),
      ),
    );
    const session = newSession();
    const ended = vi.fn();
    session.onExpired(ended);
    session.setAccessToken('revoked-token');
    await session.fetch(new Request(`${API}/api/v1/me`));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('leaves a 401 alone when no one was signed in (a wrong password is not an expired session)', async () => {
    const wrong = fixture('auth-login.json', 'invalidCredentials');
    let refreshes = 0;
    server.use(
      http.post(`${API}/api/v1/auth/refresh`, () => {
        refreshes++;
        return HttpResponse.json(refreshed);
      }),
      http.post(`${API}/api/v1/auth/login`, () => HttpResponse.json(wrong.body, { status: 401 })),
    );
    const session = newSession();
    const res = await session.fetch(new Request(`${API}/api/v1/auth/login`, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(refreshes).toBe(0);
  });

  it('never writes the token to browser storage or cookies', async () => {
    serveRefreshAndMe();
    const session = newSession();
    await session.refresh();
    expect(session.accessToken).toBe(refreshed.accessToken);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain(refreshed.accessToken);
  });
});
