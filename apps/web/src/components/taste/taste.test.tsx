import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedLayout from '@/app/(app)/layout';
import HomePage from '@/app/(app)/page';
import { session } from '@/lib/api/client';
import { AuthProvider } from '@/lib/auth/auth-context';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { setLocation } from '@/test/navigation';
import { respond, server } from '@/test/server';
import { ImportRatings } from './import-ratings';
import { QuestionnaireForm } from './questionnaire-form';
import { QuickRate } from './quick-rate';
import { TasteProfilePage } from './taste-profile-page';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);
// Fast polling and a small size limit, so tests neither wait nor build 10 MB files.
vi.mock('@/lib/config', async (original) => ({
  ...(await original<typeof import('@/lib/config')>()),
  IMPORT_POLL_MS: 10,
  IMPORT_MAX_BYTES: 5000,
}));

const url = (path: string) => `${API_URL}/api/v1${path}`;
const me = fixture('me.json', 'success').body as Record<string, unknown>;

/** Signed in as the fixture reader, with the given onboarding state (changeable later). */
function signedInAs(state: { onboardingState: string }) {
  let meCalls = 0;
  server.use(
    respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'success'),
    http.get(url('/me'), () => {
      meCalls += 1;
      return HttpResponse.json({ ...me, onboardingState: state.onboardingState });
    }),
  );
  return { meCalls: () => meCalls };
}

function renderPage(ui: React.ReactNode) {
  return render(
    <StrictMode>
      <AuthProvider>
        <ProtectedLayout>{ui}</ProtectedLayout>
      </AuthProvider>
    </StrictMode>,
  );
}

/** Records request bodies by method and path. */
function recordBodies() {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  server.events.on('request:start', async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' || path.endsWith('/auth/refresh')) return;
    // jsdom cannot stream a multipart body twice; uploads are checked through FormData instead.
    if (request.headers.get('content-type')?.startsWith('multipart/')) {
      seen.push({ method: request.method, path, body: 'multipart' });
      return;
    }
    const text = await request.clone().text();
    const body: unknown = text ? JSON.parse(text) : null;
    seen.push({ method: request.method, path, body });
  });
  return seen;
}

beforeEach(() => {
  session.clear();
  setLocation('/');
  server.events.removeAllListeners();
});

describe('Onboarding (D-002)', () => {
  it('ONB-2: a new reader is offered import, quick rate, the questionnaire and skip, with thresholds from the API', async () => {
    signedInAs({ onboardingState: 'pending' });
    server.use(respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'newReader'));
    renderPage(<HomePage />);
    expect(
      await screen.findByRole('heading', { name: 'Tell us what you like to read' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /Import ratings/ })).toHaveAttribute(
      'href',
      '/taste/import',
    );
    expect(screen.getByRole('link', { name: /Quick rate/ })).toHaveAttribute('href', '/taste/rate');
    expect(screen.getByRole('link', { name: /Questionnaire/ })).toHaveAttribute(
      'href',
      '/taste/questionnaire',
    );
    expect(
      await screen.findByText(/Rate at least 3 books to see a personal match; 10 or more/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeVisible();
  });

  it('ONB-2: skipping leads to discovery, where public results are available', async () => {
    const state = { onboardingState: 'pending' };
    signedInAs(state);
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'newReader'),
      http.post(url('/onboarding/skip'), () => {
        state.onboardingState = 'skipped';
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage(<HomePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(
      await screen.findByRole('heading', { name: 'Should you read this book?' }),
    ).toBeVisible();
  });

  it('says so when skipping is turned off, and keeps the choices', async () => {
    signedInAs({ onboardingState: 'pending' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'newReader'),
      respond('post', '/api/v1/onboarding/skip', 'onboarding-skip.json', 'skippingTurnedOff'),
    );
    renderPage(<HomePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText(/Skipping is turned off for now/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Quick rate/ })).toBeVisible();
  });

  it('is not shown again once the reader has saved something or skipped', async () => {
    signedInAs({ onboardingState: 'completed' });
    renderPage(<HomePage />);
    expect(
      await screen.findByRole('heading', { name: 'Should you read this book?' }),
    ).toBeVisible();
    expect(screen.queryByText('Tell us what you like to read')).not.toBeInTheDocument();
  });
});

describe('Quick rate', () => {
  it('ONB-2: rating a book saves it, updates the progress from the API, and ends onboarding', async () => {
    const auth = signedInAs({ onboardingState: 'pending' });
    const popular = fixture('catalog-search.json', 'popular').body as {
      items: Array<{ editionId: string; title: string }>;
    };
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('get', '/api/v1/catalog/search', 'catalog-search.json', 'popular'),
      http.put(url('/ratings/:editionId'), () =>
        HttpResponse.json(fixture('ratings-put.json', 'saved').body),
      ),
    );
    const bodies = recordBodies();
    renderPage(<QuickRate />);
    expect(await screen.findByText('6 of 10 for a confident match')).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Books to rate' });
    const book = popular.items[1]!;
    const row = within(list).getByRole('group', { name: `Your rating for ${book.title}` });
    const callsBefore = auth.meCalls();
    await userEvent.click(within(row).getByRole('button', { name: '4 out of 5' }));
    expect(await screen.findByText('7 of 10 for a confident match')).toBeVisible();
    expect(within(row).getByRole('button', { name: '4 out of 5' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(bodies).toContainEqual({
      method: 'PUT',
      path: `/api/v1/ratings/${book.editionId}`,
      body: { rating: 4 },
    });
    await waitFor(() => expect(auth.meCalls()).toBeGreaterThan(callsBefore));
  });

  it('searches the catalog with what the reader typed', async () => {
    signedInAs({ onboardingState: 'completed' });
    const asked: Array<string | null> = [];
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      http.get(url('/catalog/search'), ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        asked.push(q);
        return HttpResponse.json(
          fixture('catalog-search.json', q ? 'typed' : 'popular').body as object,
        );
      }),
    );
    renderPage(<QuickRate />);
    await screen.findByText('Most-read books');
    await userEvent.type(screen.getByLabelText('Find a book you have read'), 'harry potter');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Books matching “harry potter”')).toBeVisible();
    expect(asked).toContain('harry potter');
  });

  it('shows a refused save on that book, keeping its old rating', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('get', '/api/v1/catalog/search', 'catalog-search.json', 'popular'),
      http.put(url('/ratings/:editionId'), () =>
        HttpResponse.json(fixture('ratings-put.json', 'rateLimited').body, { status: 429 }),
      ),
    );
    renderPage(<QuickRate />);
    const list = await screen.findByRole('list', { name: 'Books to rate' });
    const first = within(list).getAllByRole('listitem')[0]!;
    await userEvent.click(within(first).getByRole('button', { name: '2 out of 5' }));
    expect(await within(first).findByRole('alert')).toHaveTextContent('Too many attempts');
    expect(within(first).getByText('You rated it 5 / 5')).toBeVisible();
  });
});

describe('Import (ONB-1)', () => {
  const csv = () =>
    new File(['Title,Author,My Rating\n'], 'goodreads_library_export.csv', { type: 'text/csv' });

  it('ONB-1: uploads the export, waits for matching, lists every unmatched row, and saves skipped rows explicitly', async () => {
    signedInAs({ onboardingState: 'completed' });
    let polls = 0;
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('post', '/api/v1/ratings/import', 'ratings-import.json', 'started'),
      http.get(url('/ratings/import/:importId'), () => {
        polls += 1;
        return HttpResponse.json(
          fixture('ratings-import-get.json', polls === 1 ? 'processing' : 'needsReview')
            .body as object,
        );
      }),
      respond(
        'post',
        `/api/v1/ratings/import/${(fixture('ratings-import.json', 'started').body as { importId: string }).importId}/confirm`,
        'ratings-import-confirm.json',
        'confirmed',
      ),
    );
    const append = vi.spyOn(FormData.prototype, 'append');
    const bodies = recordBodies();
    renderPage(<ImportRatings />);
    await userEvent.upload(await screen.findByLabelText('Export file (CSV)'), csv());
    expect(append).toHaveBeenCalledWith('file', expect.any(File), 'goodreads_library_export.csv');
    append.mockRestore();

    expect(await screen.findByText('Goodreads export is ready')).toBeVisible();
    const summary = screen.getByText('Rated rows').closest('dl')!;
    expect(summary).toHaveTextContent('Rated rows212');
    expect(summary).toHaveTextContent('Matched to a book205');
    expect(summary).toHaveTextContent('Not matched2');
    expect(summary).toHaveTextContent('Ignored, no rating37');
    const rows = within(screen.getByRole('list', { name: 'Rows not matched' })).getAllByRole(
      'listitem',
    );
    expect(rows[0]).toHaveTextContent('Pride and Prejudice');
    expect(rows[0]).toHaveTextContent('Jane Austen · your rating 3 / 5');
    expect(within(rows[0]!).getAllByRole('radio')).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('A Book Nobody Has');
    expect(rows[1]).toHaveTextContent('No close match was suggested');

    await userEvent.click(screen.getByRole('button', { name: 'Save 205 ratings' }));
    expect(
      await screen.findByText(/You now have 209 rated books \(taste profile version 2\)/),
    ).toBeVisible();
    expect(bodies.find((b) => b.path.endsWith('/confirm'))?.body).toEqual({
      resolutions: [
        { rowIndex: 14, skip: true },
        { rowIndex: 88, skip: true },
      ],
    });
  });

  it('shows a refused save and keeps the review open', async () => {
    signedInAs({ onboardingState: 'completed' });
    const { importId } = fixture('ratings-import.json', 'started').body as { importId: string };
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('post', '/api/v1/ratings/import', 'ratings-import.json', 'started'),
      respond(
        'get',
        `/api/v1/ratings/import/${importId}`,
        'ratings-import-get.json',
        'needsReview',
      ),
      respond(
        'post',
        `/api/v1/ratings/import/${importId}/confirm`,
        'ratings-import-confirm.json',
        'alreadyConfirmed',
      ),
    );
    renderPage(<ImportRatings />);
    await userEvent.upload(await screen.findByLabelText('Export file (CSV)'), csv());
    await userEvent.click(await screen.findByRole('button', { name: 'Save 205 ratings' }));
    expect(await screen.findByText('This import was already saved.')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Rows not matched' })).toBeVisible();
  });

  it('shows why the API refused the file', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('post', '/api/v1/ratings/import', 'ratings-import.json', 'unknownFormat'),
    );
    renderPage(<ImportRatings />);
    await userEvent.upload(await screen.findByLabelText('Export file (CSV)'), csv());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Upload a Goodreads or StoryGraph export (CSV).',
    );
  });

  it('never uploads a file over the size limit', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'));
    const bodies = recordBodies();
    renderPage(<ImportRatings />);
    const big = new File([new Uint8Array(6000)], 'big.csv', { type: 'text/csv' });
    await userEvent.upload(await screen.findByLabelText('Export file (CSV)'), big);
    expect(await screen.findByRole('alert')).toHaveTextContent(/larger than/);
    expect(bodies).toEqual([]);
  });

  it('says when matching failed and nothing was saved', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('post', '/api/v1/ratings/import', 'ratings-import.json', 'started'),
      http.get(url('/ratings/import/:importId'), () =>
        HttpResponse.json(fixture('ratings-import-get.json', 'failed').body as object),
      ),
    );
    renderPage(<ImportRatings />);
    await userEvent.upload(await screen.findByLabelText('Export file (CSV)'), csv());
    expect(await screen.findByText(/Matching this file failed on our side/)).toBeVisible();
  });
});

describe('Questionnaire (ONB-3)', () => {
  it('ONB-3: anything left unanswered is sent as unknown (null), never as a choice', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'newReader'),
      respond('get', '/api/v1/questionnaire/options', 'questionnaire-options.json', 'options'),
      respond('put', '/api/v1/questionnaire', 'questionnaire-put.json', 'saved'),
    );
    const bodies = recordBodies();
    renderPage(<QuestionnaireForm />);
    const liked = await screen.findByRole('group', { name: 'Genres you enjoy' });
    await userEvent.click(within(liked).getByRole('checkbox', { name: 'young-adult' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Fast and gripping' }));
    const grief = screen.getByRole('radiogroup', { name: 'Grief and bereavement' });
    await userEvent.click(within(grief).getByRole('radio', { name: 'Somewhat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save answers' }));
    expect(await screen.findByText(/Saved as taste profile version 3/)).toBeVisible();
    expect(bodies.find((b) => b.method === 'PUT')?.body).toEqual({
      likedGenres: ['young-adult'],
      dislikedGenres: null,
      pace: 'fast',
      themesToAvoid: [{ theme: 'Grief and bereavement', sensitivity: 'moderate' }],
    });
  });

  it('ONB-3: starts from the saved answers; "No preference" stays unknown, and a genre cannot be both liked and avoided', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      respond('get', '/api/v1/questionnaire/options', 'questionnaire-options.json', 'options'),
      respond('put', '/api/v1/questionnaire', 'questionnaire-put.json', 'saved'),
    );
    const bodies = recordBodies();
    renderPage(<QuestionnaireForm />);
    const liked = await screen.findByRole('group', { name: 'Genres you enjoy' });
    expect(within(liked).getByRole('checkbox', { name: 'young-adult' })).toBeChecked();
    const avoided = screen.getByRole('group', { name: 'Genres you avoid' });
    expect(within(avoided).getByRole('checkbox', { name: /young-adult/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Fast and gripping' })).toBeChecked();
    const violence = screen.getByRole('radiogroup', { name: 'Graphic violence and physical harm' });
    expect(within(violence).getByRole('radio', { name: 'Avoid strongly' })).toBeChecked();
    await userEvent.click(within(violence).getByRole('radio', { name: 'No preference' }));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Preferred pace' })).getByRole('radio', {
        name: 'No preference',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save answers' }));
    await screen.findByText(/Saved as taste profile version/);
    expect(bodies.find((b) => b.method === 'PUT')?.body).toEqual({
      likedGenres: ['fantasy, paranormal', 'young-adult'],
      dislikedGenres: null,
      pace: null,
      themesToAvoid: null,
    });
  });

  it('shows the field the API refused', async () => {
    signedInAs({ onboardingState: 'completed' });
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'newReader'),
      respond('get', '/api/v1/questionnaire/options', 'questionnaire-options.json', 'options'),
      respond('put', '/api/v1/questionnaire', 'questionnaire-put.json', 'likedAndDisliked'),
    );
    renderPage(<QuestionnaireForm />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save answers' }));
    expect(await screen.findByText('"fiction" cannot be both liked and disliked.')).toBeVisible();
  });
});

describe('Taste profile page', () => {
  it('shows progress, the rated books to edit or remove, and the questionnaire with unknown answers named', async () => {
    signedInAs({ onboardingState: 'completed' });
    const page = fixture('ratings-list.json', 'firstPage').body as {
      items: Array<{ editionId: string; title: string }>;
      nextCursor: string;
    };
    const cursors: Array<string | null> = [];
    server.use(
      respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'withAnswers'),
      http.get(url('/ratings'), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(cursor ? { items: [], nextCursor: null } : page);
      }),
      http.put(url('/ratings/:editionId'), () =>
        HttpResponse.json(fixture('ratings-put.json', 'saved').body),
      ),
      http.delete(url('/ratings/:editionId'), () =>
        HttpResponse.json(fixture('ratings-delete.json', 'removed').body),
      ),
    );
    const bodies = recordBodies();
    renderPage(<TasteProfilePage />);
    expect(await screen.findByText('6 of 10 for a confident match')).toBeVisible();
    expect(
      screen.getByText(/You get a personal match, marked low confidence until you have rated 10/),
    ).toBeVisible();
    expect(screen.getByText(/^Version 7, saved/)).toBeVisible();

    const ratings = await screen.findByRole('list', { name: 'Your ratings' });
    const [harry, hunger] = within(ratings).getAllByRole('listitem');
    expect(harry).toHaveTextContent('You rated it 4 / 5');
    await userEvent.click(within(harry!).getByRole('button', { name: '5 out of 5' }));
    expect(await screen.findByText('7 of 10 for a confident match')).toBeVisible();
    await userEvent.click(within(hunger!).getByRole('button', { name: /^Remove/ }));
    expect(await within(hunger!).findByText('Not rated')).toBeVisible();
    expect(bodies.map((b) => `${b.method} ${b.path}`)).toEqual([
      `PUT /api/v1/ratings/${page.items[0]!.editionId}`,
      `DELETE /api/v1/ratings/${page.items[1]!.editionId}`,
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(cursors).toContain(page.nextCursor));

    const answers = screen
      .getByRole('heading', { name: 'Questionnaire (optional)' })
      .closest('div')!.parentElement!;
    expect(answers).toHaveTextContent('Genres you enjoyfantasy, paranormal, young-adult');
    expect(answers).toHaveTextContent(
      'Genres you avoidNot answered (unknown, does not affect your match)',
    );
    expect(answers).toHaveTextContent('Graphic violence and physical harm (avoid strongly)');
  });

  it('a reader with nothing saved is pointed to quick rate and import, without asking for ratings', async () => {
    signedInAs({ onboardingState: 'skipped' });
    server.use(respond('get', '/api/v1/taste-profile', 'taste-profile.json', 'newReader'));
    renderPage(<TasteProfilePage />);
    expect(await screen.findByText('Nothing saved yet.')).toBeVisible();
    expect(await screen.findByText(/No rated books yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Rate some books you have read' })).toHaveAttribute(
      'href',
      '/taste/rate',
    );
    expect(screen.getByText(/Rate at least 3 books to see a personal match/)).toBeVisible();
  });
});
