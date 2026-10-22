import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from '@/app/(auth)/layout';
import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';
import LoginPage from '@/app/(auth)/login/page';
import RegisterPage from '@/app/(auth)/register/page';
import ResetPasswordPage from '@/app/(auth)/reset-password/page';
import NotFound from '@/app/not-found';
import ProtectedLayout from '@/app/(app)/layout';
import HomePage from '@/app/(app)/page';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';
import { Compare } from '@/components/compare/compare';
import { History } from '@/components/history/history';
import { ReadingList } from '@/components/reading-list/reading-list';
import { Settings } from '@/components/settings/settings';
import { StudyScreen } from '@/components/study/study';
import { ImportRatings } from '@/components/taste/import-ratings';
import { ImportReview } from '@/components/taste/import-review';
import { QuestionnaireForm } from '@/components/taste/questionnaire-form';
import { QuickRate } from '@/components/taste/quick-rate';
import { TasteProfilePage } from '@/components/taste/taste-profile-page';
import { session } from '@/lib/api/client';
import { AuthProvider } from '@/lib/auth/auth-context';
import { API_URL } from '@/lib/config';
import { axeViolations } from '@/test/axe';
import { fixture } from '@/test/fixtures';
import { setLocation } from '@/test/navigation';
import { respond, server } from '@/test/server';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

/**
 * FE-11: every screen, in the states the contract fixtures describe, has no
 * accessibility violation axe-core can find (labels, names, roles, landmarks,
 * headings, alt text, ARIA). Rendered inside the real app shell, as a reader
 * sees them.
 */

const ANALYSIS_ID = '0b10b26f-04e1-598b-a2ac-cdac933ae226';
const body = (file: string, name: string) => fixture(file, name).body as Record<string, unknown>;

/** Signed in as the fixture reader, with every screen's data answered from the fixtures. */
function signedIn(overrides: { me?: Record<string, unknown> } = {}) {
  server.use(
    respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'success'),
    http.get(`${API_URL}/api/v1/me`, () =>
      HttpResponse.json({
        ...body('me.json', 'success'),
        onboardingState: 'completed',
        ...overrides.me,
      }),
    ),
    respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
    respond('get', '/api/v1/ratings', 'ratings-list.json', 'firstPage'),
    respond('get', '/api/v1/questionnaire/options', 'questionnaire-options.json', 'options'),
    respond('get', '/api/v1/catalog/search', 'catalog-search.json', 'popular'),
    respond('get', '/api/v1/analyses', 'analyses-list.json', 'history'),
    respond('get', '/api/v1/reading-list', 'reading-list-get.json', 'list'),
    respond('get', '/api/v1/study', 'study-get.json', 'eligible'),
    respond('get', '/api/v1/compare', 'compare.json', 'compared'),
  );
}

function inShell(node: React.ReactNode) {
  return render(
    <StrictMode>
      <AuthProvider>
        <ProtectedLayout>{node}</ProtectedLayout>
      </AuthProvider>
    </StrictMode>,
  );
}

async function expectAccessible() {
  expect(await axeViolations()).toEqual([]);
}

beforeEach(() => {
  session.clear();
  setLocation('/');
});

describe('Accessibility of every screen (FE-11)', () => {
  it('discovery, and onboarding for a new reader', async () => {
    signedIn();
    const { unmount } = inShell(<HomePage />);
    await screen.findByRole('searchbox');
    await expectAccessible();
    unmount();
    signedIn({ me: { onboardingState: 'pending' } });
    inShell(<HomePage />);
    await screen.findByRole('heading', { level: 1 });
    await expectAccessible();
  });

  it.each([
    'running',
    'complete',
    'limitedEvidence',
    'insufficientEvidence',
    'allSourcesFailed',
    'personalFailed',
    'belowFloor',
    'needsTasteData',
    'fallbackModel',
    'outdated',
    'stalePublicReception',
  ])('the result screen: %s', async (outcome) => {
    signedIn();
    const analysis = { ...body('analyses-get.json', outcome), pollAfterMs: null };
    server.use(
      http.get(`${API_URL}/api/v1/analyses/${ANALYSIS_ID}`, () => HttpResponse.json(analysis)),
    );
    inShell(<AnalysisScreen id={ANALYSIS_ID} />);
    await screen.findByRole('region', { name: 'Public reception' });
    await expectAccessible();
  });

  it.each([
    ['history', () => screen.findByRole('list', { name: 'Analyses' })],
    ['empty', () => screen.findByText('No analyses yet')],
  ] as const)('history: %s', async (outcome, loaded) => {
    signedIn();
    server.use(respond('get', '/api/v1/analyses', 'analyses-list.json', outcome));
    inShell(<History />);
    await loaded();
    await expectAccessible();
  });

  it.each([
    ['list', () => screen.findByRole('list', { name: 'Ranked by your match' })],
    ['empty', () => screen.findByText('Your reading list is empty')],
  ] as const)('the reading list: %s', async (outcome, loaded) => {
    signedIn();
    server.use(respond('get', '/api/v1/reading-list', 'reading-list-get.json', outcome));
    inShell(<ReadingList />);
    await loaded();
    await expectAccessible();
  });

  it('compare', async () => {
    signedIn();
    inShell(<Compare a={ANALYSIS_ID} b="1c4b7c8e-2c5d-5b0e-9d5a-7e3f2a1b0c9d" />);
    await screen.findByRole('region', { name: 'Compare two books' });
    await screen.findAllByRole('heading', { level: 2 });
    await expectAccessible();
  });

  it('settings', async () => {
    signedIn();
    inShell(<Settings />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await expectAccessible();
  });

  it.each([
    ['tooFewRatings', () => screen.findByRole('heading', { name: 'Not ready to take part yet' })],
    ['eligible', () => screen.findByRole('button', { name: 'Join the study' })],
    ['joined', () => screen.findByRole('list', { name: 'Hidden books' })],
  ] as const)('the user study: %s', async (outcome, loaded) => {
    signedIn();
    server.use(respond('get', '/api/v1/study', 'study-get.json', outcome));
    inShell(<StudyScreen />);
    await loaded();
    await expectAccessible();
  });

  it.each([
    ['taste profile', TasteProfilePage, () => screen.findByRole('list', { name: 'Your ratings' })],
    ['quick rate', QuickRate, () => screen.findByRole('list', { name: 'Books to rate' })],
    [
      'questionnaire',
      QuestionnaireForm,
      () => screen.findByRole('group', { name: /Genres you enjoy/ }),
    ],
    ['import', ImportRatings, () => screen.findByRole('heading', { level: 1 })],
  ] as const)('the %s screen', async (_label, Screen, loaded) => {
    signedIn();
    inShell(<Screen />);
    await loaded();
    await expectAccessible();
  });

  it('the import review', async () => {
    signedIn();
    const data = body('ratings-import-get.json', 'needsReview');
    inShell(
      <ImportReview
        data={data as never}
        saving={false}
        error={null}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await screen.findAllByRole('radio');
    await expectAccessible();
  });

  it.each([
    ['sign in', LoginPage],
    ['create account', RegisterPage],
    ['forgot password', ForgotPasswordPage],
  ] as const)('the %s page', async (_label, Page) => {
    server.use(
      respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'noValidRefreshCookie'),
    );
    render(
      <StrictMode>
        <AuthProvider>
          <AuthLayout>
            <Page />
          </AuthLayout>
        </AuthProvider>
      </StrictMode>,
    );
    await screen.findByRole('heading', { level: 1 });
    await expectAccessible();
  });

  it.each([
    ['with a token', '/reset-password#token=abc123', 'Choose a new password'],
    ['without a token', '/reset-password', 'This link does not work'],
  ])('the reset password page %s', async (_label, path, heading) => {
    setLocation(path);
    server.use(
      respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'noValidRefreshCookie'),
    );
    render(
      <StrictMode>
        <AuthProvider>
          <AuthLayout>
            <ResetPasswordPage />
          </AuthLayout>
        </AuthProvider>
      </StrictMode>,
    );
    await screen.findByRole('heading', { level: 1, name: heading });
    await expectAccessible();
  });

  it('the page-not-found page', async () => {
    render(<NotFound />);
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });
    await expectAccessible();
  });
});
