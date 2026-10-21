/**
 * The signed-in session (D-001, CONTRACT 2 and 4.1).
 *
 * - The access token lives only in this object's memory: never in
 *   localStorage, sessionStorage or a cookie we can read.
 * - The refresh token is an httpOnly cookie the browser sends to
 *   /api/v1/auth/*; JavaScript never sees it.
 * - Refresh tokens rotate on every use, so only one refresh may run at a
 *   time: calls in this tab share one request, and other tabs wait on a
 *   Web Lock (CONTRACT 4.1).
 */
export interface SessionDeps {
  apiUrl: string;
  fetch: typeof fetch;
  /** Web Locks, for one refresh at a time across tabs. Optional. */
  locks?: Pick<LockManager, 'request'>;
}

const LOCK_NAME = 'bookie-auth-refresh';

export class Session {
  private token: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly expiredListeners = new Set<() => void>();

  constructor(private readonly deps: SessionDeps) {}

  get accessToken(): string | null {
    return this.token;
  }

  setAccessToken(token: string): void {
    this.token = token;
  }

  clear(): void {
    this.token = null;
  }

  /**
   * Gets a new access token with the refresh cookie. Returns false when the
   * reader has to sign in again. Calls made while one is running share it.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.refreshOnce().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The session ended while in use (refresh failed or token rejected). */
  expire(): void {
    this.token = null;
    for (const listener of this.expiredListeners) listener();
  }

  onExpired(listener: () => void): () => void {
    this.expiredListeners.add(listener);
    return () => this.expiredListeners.delete(listener);
  }

  private async refreshOnce(): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        const res = await this.deps.fetch(`${this.deps.apiUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          this.token = null;
          return false;
        }
        const body = (await res.json()) as { accessToken?: unknown };
        if (typeof body.accessToken !== 'string') return false;
        this.token = body.accessToken;
        return true;
      } catch {
        // Network failure: the session may still be fine; keep what we have.
        return false;
      }
    };
    return this.deps.locks ? this.deps.locks.request(LOCK_NAME, run) : run();
  }

  /**
   * `fetch` for API calls: adds the access token, and on 401 TOKEN_EXPIRED
   * refreshes once and retries once (CONTRACT 2, silent refresh). Any other
   * 401 on a signed-in call ends the session.
   */
  readonly fetch = async (request: Request): Promise<Response> => {
    const retry = request.clone();
    const hadToken = this.token !== null;
    const response = await this.send(request);
    if (response.status !== 401 || !hadToken) return response;

    const code = await response
      .clone()
      .json()
      .then((b: { code?: string }) => b.code)
      .catch(() => undefined);
    if (code === 'TOKEN_EXPIRED' && (await this.refresh())) return this.send(retry);
    if (code === 'TOKEN_EXPIRED' || code === 'UNAUTHENTICATED') this.expire();
    return response;
  };

  private send(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return this.deps.fetch(new Request(request, { headers, credentials: 'include' }));
  }
}
