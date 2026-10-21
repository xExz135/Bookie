import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedLayout from '@/app/(app)/layout';
import { session } from '@/lib/api/client';
import { AuthProvider } from '@/lib/auth/auth-context';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { router, setLocation } from '@/test/navigation';
import { respond, server } from '@/test/server';
import { Settings } from './settings';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const DELETE = `${API_URL}/api/v1/me/data`;
const me = fixture('me.json', 'success').body as Record<string, unknown>;

/** Signed in as the fixture reader, whose onboarding state can change. */
function signedIn(state = { onboardingState: 'completed' }) {
  server.use(
    respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'success'),
    http.get(`${API_URL}/api/v1/me`, () => HttpResponse.json({ ...me, ...state })),
  );
  return state;
}

function renderSettings() {
  return render(
    <StrictMode>
      <AuthProvider>
        <ProtectedLayout>
          <Settings />
        </ProtectedLayout>
      </AuthProvider>
    </StrictMode>,
  );
}

async function fillAndConfirm(password: string) {
  await userEvent.type(await screen.findByLabelText('Your password'), password);
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
}

beforeEach(() => {
  session.clear();
  setLocation('/settings');
  router.push.mockReset();
});

describe('Settings (FE-9)', () => {
  it('shows the account and where to edit ratings', async () => {
    signedIn();
    renderSettings();
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await screen.findByText('ada@example.com')).toBeVisible();
    expect(screen.getByText('Ada', { selector: 'dd' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Edit your taste profile' })).toHaveAttribute(
      'href',
      '/taste',
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('SEC-3: says what is removed and kept, and needs the password and a confirmation', async () => {
    signedIn();
    renderSettings();
    expect(await screen.findByText('Removed for good')).toBeVisible();
    expect(screen.getByText(/Every analysis in your history/)).toBeVisible();
    expect(screen.getByText(/Your account: email, password and display name/)).toBeVisible();
    const button = screen.getByRole('button', { name: 'Delete my data' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your password'), 'secret');
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
    expect(button).toBeEnabled();
  });

  it('SEC-3: deletes with the password, reloads the reader and starts over at the welcome screen', async () => {
    const state = signedIn();
    let sent: unknown = null;
    server.use(
      http.delete(DELETE, async ({ request }) => {
        sent = await request.json();
        state.onboardingState = 'pending';
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderSettings();
    await fillAndConfirm('my password');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    expect(await screen.findByText(/Your data was deleted/)).toBeVisible();
    expect(sent).toEqual({ password: 'my password' });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'));
  });

  it('shows a wrong password on the field and deletes nothing', async () => {
    signedIn();
    server.use(respond('delete', '/api/v1/me/data', 'me-data-delete.json', 'wrongPassword'));
    renderSettings();
    await fillAndConfirm('not it');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    expect(await screen.findByText('That password is not correct.')).toBeVisible();
    expect(screen.getByLabelText('Your password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(/Your data was deleted/)).not.toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says when there were too many attempts', async () => {
    signedIn();
    server.use(respond('delete', '/api/v1/me/data', 'me-data-delete.json', 'rateLimited'));
    renderSettings();
    await fillAndConfirm('my password');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Too many attempts. Try again in 50 minutes/,
    );
  });
});
