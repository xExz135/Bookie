import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';
import { session } from '@/lib/api/client';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { respond, server } from '@/test/server';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const ID = '0b10b26f-04e1-598b-a2ac-cdac933ae226';
const HUNGER_GAMES = 'a6da1682-d49f-5c15-b566-5f88f2a453a0';
const LIST = `${API_URL}/api/v1/reading-list`;

function renderScreen() {
  server.use(respond('get', `/api/v1/analyses/${ID}`, 'analyses-get.json', 'complete'));
  return render(
    <StrictMode>
      <AnalysisScreen id={ID} />
    </StrictMode>,
  );
}

beforeEach(() => {
  session.clear();
});

describe('Save to reading list on the result screen (FE-8)', () => {
  it('saves the book and can remove it again', async () => {
    server.use(respond('get', '/api/v1/reading-list', 'reading-list-get.json', 'empty'));
    const sent: unknown[] = [];
    const removed: string[] = [];
    server.use(
      http.post(LIST, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(fixture('reading-list-add.json', 'added').body as object, {
          status: 201,
        });
      }),
      http.delete(`${LIST}/:editionId`, ({ params }) => {
        removed.push(params.editionId as string);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderScreen();
    const save = await screen.findByRole('button', { name: 'Save to reading list' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText('On your reading list')).toBeVisible();
    expect(sent).toEqual([{ editionId: HUNGER_GAMES }]);
    expect(screen.getByRole('link', { name: 'Open the reading list' })).toHaveAttribute(
      'href',
      '/reading-list',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove from reading list' }));
    expect(await screen.findByRole('button', { name: 'Save to reading list' })).toBeVisible();
    expect(removed).toEqual([HUNGER_GAMES]);
  });

  it('shows a book already on the list as saved', async () => {
    server.use(respond('get', '/api/v1/reading-list', 'reading-list-get.json', 'list'));
    renderScreen();
    expect(await screen.findByText('On your reading list')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save to reading list' })).toBeNull();
  });

  it('still offers saving when the list cannot be read', async () => {
    server.use(http.get(LIST, () => HttpResponse.error()));
    renderScreen();
    const save = await screen.findByRole('button', { name: 'Save to reading list' });
    await waitFor(() => expect(save).toBeEnabled());
  });

  it('says when saving failed and stays unsaved', async () => {
    server.use(
      respond('get', '/api/v1/reading-list', 'reading-list-get.json', 'empty'),
      http.post(LIST, () => HttpResponse.error()),
    );
    renderScreen();
    const save = await screen.findByRole('button', { name: 'Save to reading list' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText(/We cannot reach Bookie right now/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save to reading list' })).toBeEnabled();
    expect(screen.queryByText('On your reading list')).toBeNull();
  });
});
