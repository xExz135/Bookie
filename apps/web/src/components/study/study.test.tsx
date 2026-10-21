import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { server } from '@/test/server';
import { StudyScreen } from './study';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const STUDY = '/api/v1/study';
const body = (file: string, name: string) => fixture(file, name).body as Record<string, unknown>;

/** Answers GET /study with one outcome (Strict Mode loads twice, so tests switch it on an action). */
function serve(outcome: string) {
  server.use(
    http.get(`${API_URL}${STUDY}`, () => HttpResponse.json(body('study-get.json', outcome))),
  );
}

function renderStudy() {
  return render(
    <StrictMode>
      <StudyScreen />
    </StrictMode>,
  );
}

beforeEach(() => {
  session.clear();
});

describe('User study (FE-10, spec 9)', () => {
  it('with too few rated books, says how many are needed and links to rating, with no way to join', async () => {
    serve('tooFewRatings');
    renderStudy();
    expect(
      await screen.findByText(
        'You have rated 8 books. Rate at least 15 books you have read to take part.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Rate books you have read' })).toHaveAttribute(
      'href',
      '/taste/rate',
    );
    expect(screen.queryByRole('button', { name: 'Join the study' })).not.toBeInTheDocument();
  });

  it('explains when too few rated books are known to the model, or no model is loaded', async () => {
    serve('tooFewKnownBooks');
    const { unmount } = renderStudy();
    expect(
      await screen.findByText(/3 of your rated books are among the books the model knows, and 5/),
    ).toBeVisible();
    unmount();
    serve('noModel');
    renderStudy();
    expect(await screen.findByText(/Personal matching is not available yet/)).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Rate books you have read' }),
    ).not.toBeInTheDocument();
  });

  it('spec 9: asks for consent first, then joins and shows the hidden books', async () => {
    serve('eligible');
    let sent: unknown = null;
    server.use(
      http.post(`${API_URL}${STUDY}`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(body('study-join.json', 'joined'), { status: 201 });
      }),
    );
    renderStudy();
    const join = await screen.findByRole('button', { name: 'Join the study' });
    expect(join).toBeDisabled();
    expect(screen.getByText(/5 of your 18 rated books are picked at random/)).toBeVisible();
    expect(screen.getByText(/without your name or email/, { selector: 'p' })).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: /I agree to take part/ }));
    await userEvent.click(join);
    expect(sent).toEqual({ consent: true });
    expect(await screen.findByRole('list', { name: 'Hidden books' })).toBeVisible();
  });

  it('D-010: each hidden book shows your rating, the prediction and the baseline separately, never a percentage', async () => {
    serve('joined');
    const { container } = renderStudy();
    const list = await screen.findByRole('list', { name: 'Hidden books' });
    const books = within(list).getAllByRole('listitem');
    expect(books).toHaveLength(5);
    const first = within(books[0]!);
    expect(first.getByRole('heading', { name: 'The Hunger Games' })).toBeVisible();
    const figure = (label: string) => first.getByText(label).parentElement!;
    expect(figure('Your rating')).toHaveTextContent('5 / 5');
    expect(figure('Predicted')).toHaveTextContent('4.31 / 5');
    expect(figure('Predicted')).toHaveTextContent('collaborative model (B3), medium confidence');
    expect(figure('Baseline')).toHaveTextContent('4.21 / 5');
    expect(figure('Baseline')).toHaveTextContent('(B0)');
    expect(screen.getByText(/not a probability that you will enjoy it/)).toBeVisible();
    expect(screen.getByText(/release 2026-10-21\.6533ea0e/)).toBeVisible();
    expect(container.textContent).not.toMatch(/%/);
  });

  it('leaving asks once more, deletes the participation and shows the study again', async () => {
    serve('joined');
    let deleted = false;
    server.use(
      http.delete(`${API_URL}${STUDY}`, () => {
        deleted = true;
        serve('eligible');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderStudy();
    await userEvent.click(await screen.findByRole('button', { name: 'Leave the study' }));
    expect(deleted).toBe(false);
    expect(screen.getByText(/Your hidden books and their predictions are deleted/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, leave the study' }));
    expect(deleted).toBe(true);
    expect(await screen.findByRole('button', { name: 'Join the study' })).toBeVisible();
  });

  it('a refused join shows what is needed now', async () => {
    serve('eligible');
    server.use(
      http.post(`${API_URL}${STUDY}`, () => {
        // The reader removed ratings in another tab meanwhile.
        serve('tooFewRatings');
        return HttpResponse.json(body('study-join.json', 'notEligible'), { status: 409 });
      }),
    );
    renderStudy();
    await userEvent.click(await screen.findByRole('checkbox', { name: /I agree to take part/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Join the study' }));
    expect(await screen.findByText(/Rate at least 15 books/)).toBeVisible();
  });

  it('offers to try again when the study cannot be loaded', async () => {
    let fail = true;
    server.use(
      http.get(`${API_URL}${STUDY}`, () =>
        fail ? HttpResponse.error() : HttpResponse.json(body('study-get.json', 'eligible')),
      ),
    );
    renderStudy();
    expect(await screen.findByText(/We cannot reach Bookie right now/)).toBeVisible();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Join the study' })).toBeVisible();
  });
});
