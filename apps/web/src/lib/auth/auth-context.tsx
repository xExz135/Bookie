'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, call, session } from '@/lib/api/client';
import type { User } from '@/lib/api/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: User | null;
  /** True when the session ended while in use, not by signing out. */
  sessionExpired: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: { email: string; password: string; displayName: string }): Promise<void>;
  logout(): Promise<void>;
  /** Forget the session in this tab without calling the API (for example after a password reset). */
  forget(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Tells other tabs about sign-in and sign-out, so they follow along. */
const CHANNEL = 'bookie-auth';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const statusRef = useRef<Status>('loading');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const signedOut = useCallback(() => {
    session.clear();
    setUser(null);
    setStatus('anonymous');
  }, []);

  /** On page load there is no token in memory: refresh, then load the user (CONTRACT 4.1). */
  const restore = useCallback(async () => {
    if (!(await session.refresh())) return signedOut();
    try {
      setUser(await call(api.GET('/api/v1/me')));
      setStatus('authenticated');
    } catch {
      signedOut();
    }
  }, [signedOut]);

  useEffect(() => {
    void restore();
    const unsubscribe = session.onExpired(() => {
      if (statusRef.current === 'authenticated') setSessionExpired(true);
      signedOut();
    });
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = (event: MessageEvent<string>) => {
        if (event.data === 'logout') signedOut();
        // Another tab signed in: pick up the session if this one has none.
        if (event.data === 'login' && statusRef.current === 'anonymous') void restore();
      };
    }
    return () => {
      unsubscribe();
      channel.current?.close();
      channel.current = null;
    };
  }, [restore, signedOut]);

  const signedIn = useCallback((result: { accessToken: string; user: User }) => {
    session.setAccessToken(result.accessToken);
    setSessionExpired(false);
    setUser(result.user);
    setStatus('authenticated');
    channel.current?.postMessage('login');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionExpired,
      async login(email, password) {
        signedIn(await call(api.POST('/api/v1/auth/login', { body: { email, password } })));
      },
      async register(input) {
        signedIn(await call(api.POST('/api/v1/auth/register', { body: input })));
      },
      async logout() {
        try {
          await call(api.POST('/api/v1/auth/logout'));
        } finally {
          signedOut();
          channel.current?.postMessage('logout');
        }
      },
      forget: signedOut,
    }),
    [status, user, sessionExpired, signedIn, signedOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/**
 * Where to go after signing in. Only paths on this site are allowed, so a
 * crafted ?next= link cannot send the reader elsewhere.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
