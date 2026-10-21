import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import { AuthProvider, safeNext } from '@/lib/auth/auth-context';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { router, setLocation } from '@/test/navigation';
import { respond, server, signedIn, signedOut } from '@/test/server';
import ProtectedLayout from './(app)/layout';
import ForgotPasswordPage from './(auth)/forgot-password/page';
import LoginPage from './(auth)/login/page';
import RegisterPage from './(auth)/register/page';
import ResetPasswordPage from './(auth)/reset-password/page';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const user = fixture('me.json', 'success').body as { displayName: string };

/** Strict Mode runs effects twice, as `next dev` does, so tests catch effects that are not safe to repeat. */
function renderWithAuth(ui: React.ReactNode) {
  return render(
    <StrictMode>
      <AuthProvider>{ui}</AuthProvider>
    </StrictMode>,
  );
}

async function fillLogin(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  router.replace.mockReset();
  session.clear();
  setLocation('/');
});

describe('SEC-2: protected pages', () => {
  it('sends a signed-out reader to sign in, remembering where they were, without showing the page', async () => {
    server.use(...signedOut());
    setLocation('/history?page=2');
    renderWithAuth(
      <ProtectedLayout>
        <p>secret page</p>
      </ProtectedLayout>,
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/login?next=%2Fhistory%3Fpage%3D2'),
    );
    expect(screen.queryByText('secret page')).not.toBeInTheDocument();
  });

  it('restores the session on load (refresh, then /me) and shows the page', async () => {
    server.use(...signedIn());
    renderWithAuth(
      <ProtectedLayout>
        <p>secret page</p>
      </ProtectedLayout>,
    );
    expect(await screen.findByText('secret page')).toBeInTheDocument();
    expect(screen.getByText(user.displayName)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('signs out: calls the API, forgets the token, and goes to sign in', async () => {
    let loggedOut = false;
    server.use(
      ...signedIn(),
      http.post(`${API_URL}/api/v1/auth/logout`, () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithAuth(
      <ProtectedLayout>
        <p>secret page</p>
      </ProtectedLayout>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(loggedOut).toBe(true);
    expect(session.accessToken).toBeNull();
  });
});

describe('sign in', () => {
  it('signs in and goes to the page the reader came from', async () => {
    server.use(...signedOut(), respond('post', '/api/v1/auth/login', 'auth-login.json', 'success'));
    setLocation('/login?next=%2Fhistory');
    renderWithAuth(<LoginPage />);
    await fillLogin('ada@example.com', 'correct horse battery');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/history'));
    expect(session.accessToken).toEqual(expect.any(String));
  });

  it('shows our message for a wrong password, and field messages for invalid input', async () => {
    server.use(
      ...signedOut(),
      respond('post', '/api/v1/auth/login', 'auth-login.json', 'invalidCredentials'),
    );
    setLocation('/login');
    renderWithAuth(<LoginPage />);
    await fillLogin('ada@example.com', 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password do not match an account.',
    );

    server.use(respond('post', '/api/v1/auth/login', 'auth-login.json', 'validationFailed'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
  });

  it('explains throttling with the wait time', async () => {
    server.use(
      ...signedOut(),
      respond('post', '/api/v1/auth/login', 'auth-login.json', 'rateLimited'),
    );
    setLocation('/login');
    renderWithAuth(<LoginPage />);
    await fillLogin('ada@example.com', 'x');
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 14 minutes.');
  });

  it('says when the API cannot be reached', async () => {
    server.use(
      ...signedOut(),
      http.post(`${API_URL}/api/v1/auth/login`, () => HttpResponse.error()),
    );
    setLocation('/login');
    renderWithAuth(<LoginPage />);
    await fillLogin('ada@example.com', 'x');
    expect(await screen.findByRole('alert')).toHaveTextContent('We cannot reach Bookie right now.');
  });

  it('only follows ?next= to pages on this site', () => {
    expect(safeNext('/history')).toBe('/history');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('register', () => {
  async function fillRegister() {
    await userEvent.type(screen.getByLabelText('Display name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('offers sign in when the email is taken', async () => {
    server.use(
      ...signedOut(),
      respond('post', '/api/v1/auth/register', 'auth-register.json', 'emailInUse'),
    );
    setLocation('/register');
    renderWithAuth(<RegisterPage />);
    await fillRegister();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists.',
    );
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute('href', '/login');
  });

  it('signs the reader in right away (D-001)', async () => {
    server.use(
      ...signedOut(),
      respond('post', '/api/v1/auth/register', 'auth-register.json', 'success'),
    );
    setLocation('/register');
    renderWithAuth(<RegisterPage />);
    await fillRegister();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  });
});

describe('forgot and reset password', () => {
  it('confirms the same way whatever the email', async () => {
    server.use(
      ...signedOut(),
      respond('post', '/api/v1/auth/forgot-password', 'auth-forgot-password.json', 'accepted'),
    );
    renderWithAuth(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'If an account exists for nobody@example.com',
    );
  });

  it('reads the token from the link, removes it from the address bar, and resets', async () => {
    let sent: unknown = null;
    server.use(
      ...signedOut(),
      http.post(`${API_URL}/api/v1/auth/reset-password`, async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    setLocation('/reset-password#token=abc_DEF-123');
    renderWithAuth(<ResetPasswordPage />);
    await userEvent.type(await screen.findByLabelText('New password'), 'a brand new password');
    expect(window.location.hash).toBe('');
    await userEvent.type(screen.getByLabelText('Repeat new password'), 'a brand new password');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(sent).toEqual({ token: 'abc_DEF-123', newPassword: 'a brand new password' });
  });

  it('checks that both passwords match before sending', async () => {
    server.use(...signedOut());
    setLocation('/reset-password#token=abc');
    renderWithAuth(<ResetPasswordPage />);
    await userEvent.type(await screen.findByLabelText('New password'), 'one password here');
    await userEvent.type(screen.getByLabelText('Repeat new password'), 'another password');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(screen.getByText('The two passwords are not the same.')).toBeInTheDocument();
  });

  it('explains an invalid or expired link, and a link with no token', async () => {
    server.use(
      ...signedOut(),
      respond(
        'post',
        '/api/v1/auth/reset-password',
        'auth-reset-password.json',
        'invalidOrExpiredLink',
      ),
    );
    setLocation('/reset-password#token=old');
    const { unmount } = renderWithAuth(<ResetPasswordPage />);
    await userEvent.type(await screen.findByLabelText('New password'), 'a brand new password');
    await userEvent.type(screen.getByLabelText('Repeat new password'), 'a brand new password');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('This link does not work')).toBeInTheDocument();
    unmount();

    setLocation('/reset-password');
    renderWithAuth(<ResetPasswordPage />);
    expect(await screen.findByText('This link does not work')).toBeInTheDocument();
  });
});
