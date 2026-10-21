import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import { API_URL } from '@/lib/config';
import type { ReadingList as List } from '@/lib/reading-list/api';
import { fixture } from '@/test/fixtures';
import { router } from '@/test/navigation';
import { respond, server } from '@/test/server';
import { ReadingList } from './reading-list';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const LIST = `${API_URL}/api/v1/reading-list`;
const list = () =>
  structuredClone(fixture('reading-list-get.json', 'list').body) as unknown as List;

function serve(body: List) {
  server.use(http.get(LIST, () => HttpResponse.json(body)));
}

function renderList() {
  return render(
    <StrictMode>
      <ReadingList />
    </StrictMode>,
  );
}

const groupItems = async (name: string) =>
  within(await screen.findByRole('list', { name })).getAllByRole('listitem');
const titles = (items: HTMLElement[]) =>
  items.map((li) => within(li).getByRole('heading', { level: 3 }).textContent);

beforeEach(() => {
  session.clear();
  router.push.mockReset();
});

describe('Reading list (FE-8)', () => {
  it('LIST-1: shows the books in the order the API sends, never re-sorted', async () => {
    const body = list();
    // Swap the two ranked books: the screen must keep the API's order, not sort by score.
    [body.items[0], body.items[1]] = [body.items[1]!, body.items[0]!];
    serve(body);
    renderList();
    const ranked = await groupItems('Ranked by your match');
    expect(titles(ranked)).toEqual(['Divergent', 'The Hunger Games']);
    expect(ranked[0]).toHaveTextContent('Rank 1');
    expect(ranked[1]).toHaveTextContent('Rank 2');
  });

  it('LIST-2: low-confidence and unmatched books are labeled in their own groups, not ranked', async () => {
    serve(list());
    renderList();
    const ranked = await groupItems('Ranked by your match');
    expect(titles(ranked)).toEqual(['The Hunger Games', 'Divergent']);
    const low = await groupItems('Low confidence');
    expect(titles(low)).toEqual(["Ender's Game"]);
    expect(low[0]).toHaveTextContent('Low confidence, not ranked');
    expect(low[0]).not.toHaveTextContent(/Rank \d/);
    const none = await groupItems('No personal match');
    expect(titles(none)).toEqual(['The Employees', 'The Maze Runner']);
    none.forEach((li) => {
      expect(li).toHaveTextContent('No personal match');
      expect(li).not.toHaveTextContent(/Rank \d/);
    });
    // The groups come in the API's order.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Ranked by your match',
      'Low confidence',
      'No personal match',
    ]);
  });

  it('D-010: each score shows its confidence and model, with the disclaimer, never a percentage', async () => {
    serve(list());
    renderList();
    const [first] = await groupItems('Ranked by your match');
    expect(first).toHaveTextContent('4.2/ 5');
    expect(first).toHaveTextContent('Evidence confidence: Medium');
    expect(first).toHaveTextContent('Model B4 (hybrid model)');
    const [low] = await groupItems('Low confidence');
    expect(low).toHaveTextContent('Evidence confidence: Low');
    expect(low).toHaveTextContent('Fallback model B1 (questionnaire and trait match)');
    expect(screen.getByText(/It is not a probability that you will enjoy it/)).toBeVisible();
    expect(document.body).not.toHaveTextContent('%');
  });

  it('says why a book has no match, and opens the latest result', async () => {
    serve(list());
    renderList();
    const [employees, maze] = await groupItems('No personal match');
    expect(employees).toHaveTextContent('Not analyzed yet.');
    expect(within(employees!).queryByRole('link', { name: /Open the result/ })).toBeNull();
    expect(maze).toHaveTextContent('No personal match in this result');
    expect(within(maze!).getByRole('link', { name: /Open the result/ })).toHaveAttribute(
      'href',
      '/analyses/7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    );
  });

  it('marks a match made with an earlier taste profile', async () => {
    const body = list();
    body.items[0]!.personalMatch!.isOutdated = true;
    body.items[0]!.personalMatch!.currentTasteProfileVersion = 5;
    serve(body);
    renderList();
    const [first, second] = await groupItems('Ranked by your match');
    expect(first).toHaveTextContent('Made with an earlier taste profile');
    expect(second).not.toHaveTextContent('Made with an earlier taste profile');
  });

  it('starts the analysis of a book not analyzed yet and opens it', async () => {
    serve(list());
    let sent: unknown = null;
    server.use(
      http.post(`${API_URL}/api/v1/analyses`, async ({ request }) => {
        sent = await request.json();
        const started = fixture('analyses-start.json', 'started');
        return HttpResponse.json(started.body as object, { status: started.status });
      }),
    );
    renderList();
    const [employees] = await groupItems('No personal match');
    await userEvent.click(within(employees!).getByRole('button', { name: /Analyze it/ }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/analyses/6b66c974-b3d6-55d8-a9c1-317846698f90'),
    );
    expect(sent).toEqual({ editionId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' });
  });

  it('says when an analysis cannot be started', async () => {
    serve(list());
    server.use(respond('post', '/api/v1/analyses', 'analyses-start.json', 'rateLimited'));
    renderList();
    const [employees] = await groupItems('No personal match');
    await userEvent.click(within(employees!).getByRole('button', { name: /Analyze it/ }));
    expect(await within(employees!).findByRole('alert')).toHaveTextContent(/Too many attempts/);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('removes a book', async () => {
    serve(list());
    const removed: string[] = [];
    server.use(
      http.delete(`${LIST}/:editionId`, ({ params }) => {
        removed.push(params.editionId as string);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderList();
    const [, divergent] = await groupItems('Ranked by your match');
    await userEvent.click(within(divergent!).getByRole('button', { name: /Remove/ }));
    await waitFor(() =>
      expect(
        titles(
          within(screen.getByRole('list', { name: 'Ranked by your match' })).getAllByRole(
            'listitem',
          ),
        ),
      ).toEqual(['The Hunger Games']),
    );
    expect(removed).toEqual(['8b950eea-d77b-51dd-98c3-6a19c8660aaa']);
  });

  it('keeps a book whose removal failed, and says so', async () => {
    serve(list());
    server.use(http.delete(`${LIST}/:editionId`, () => HttpResponse.error()));
    renderList();
    const [, divergent] = await groupItems('Ranked by your match');
    await userEvent.click(within(divergent!).getByRole('button', { name: /Remove/ }));
    expect(await within(divergent!).findByRole('alert')).toHaveTextContent(
      /We cannot reach Bookie right now/,
    );
    expect(await groupItems('Ranked by your match')).toHaveLength(2);
  });

  it('compares two analyzed books chosen on the list, and no more than two', async () => {
    serve(list());
    renderList();
    const [hunger, divergent] = await groupItems('Ranked by your match');
    const [ender] = await groupItems('Low confidence');
    const bar = screen.getByRole('region', { name: 'Compare two books' });
    expect(within(bar).queryByRole('link', { name: 'Compare the two' })).toBeNull();

    await userEvent.click(within(hunger!).getByRole('checkbox', { name: /Compare/ }));
    expect(bar).toHaveTextContent('The Hunger Games chosen. Tick one more to compare.');
    await userEvent.click(within(ender!).getByRole('checkbox', { name: /Compare/ }));
    expect(within(bar).getByRole('link', { name: 'Compare the two' })).toHaveAttribute(
      'href',
      '/compare?a=0b10b26f-04e1-598b-a2ac-cdac933ae226&b=0c00d70d-925f-5e78-b9a4-9178063e3c26',
    );
    expect(within(divergent!).getByRole('checkbox', { name: /Compare/ })).toBeDisabled();

    // A book that was never analyzed cannot be compared.
    const [employees] = await groupItems('No personal match');
    expect(within(employees!).queryByRole('checkbox')).toBeNull();

    await userEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(within(divergent!).getByRole('checkbox', { name: /Compare/ })).toBeEnabled();
  });

  it('shows an empty list with where to find books', async () => {
    server.use(respond('get', '/api/v1/reading-list', 'reading-list-get.json', 'empty'));
    renderList();
    expect(await screen.findByText('Your reading list is empty')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Find a book' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('region', { name: 'Compare two books' })).toBeNull();
  });

  it('says when the list cannot be loaded, and tries again', async () => {
    let calls = 0;
    server.use(
      http.get(LIST, () => {
        calls += 1;
        return calls === 1 ? HttpResponse.error() : HttpResponse.json(list());
      }),
    );
    render(<ReadingList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/We cannot reach Bookie right now/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await groupItems('Ranked by your match')).toHaveLength(2);
  });
});
