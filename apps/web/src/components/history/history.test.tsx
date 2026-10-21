import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import type { AnalysisList } from '@/lib/analysis/api';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { router } from '@/test/navigation';
import { respond, server } from '@/test/server';
import { History } from './history';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const LIST = '/api/v1/analyses';
const history = () =>
  structuredClone(fixture('analyses-list.json', 'history').body) as unknown as AnalysisList;

function renderHistory() {
  return render(
    <StrictMode>
      <History />
    </StrictMode>,
  );
}

async function rows() {
  const list = await screen.findByRole('list', { name: 'Analyses' });
  return within(list).getAllByRole('listitem');
}

beforeEach(() => {
  router.push.mockReset();
  session.clear();
});

describe('History', () => {
  it('RES-1: lists every analysis in the order the API sends, including one still running, each opening its result', async () => {
    const page = history();
    server.use(http.get(`${API_URL}${LIST}`, () => HttpResponse.json(page)));
    renderHistory();
    const items = await rows();
    expect(items).toHaveLength(page.items.length);
    const running = items[0]!;
    expect(running).toHaveTextContent('Analyzing');
    expect(running).toHaveTextContent('Still being analyzed. Open it to follow the progress.');
    expect(within(running).getByRole('link', { name: /Open the full result/ })).toHaveAttribute(
      'href',
      `/analyses/${page.items[0]!.id}`,
    );
    page.items.forEach((item, i) => {
      expect(within(items[i]!).getByRole('link', { name: 'The Hunger Games' })).toHaveAttribute(
        'href',
        `/analyses/${item.id}`,
      );
    });
  });

  it('D-010: shows the public reception and the personal match as separate columns, never a percentage', async () => {
    server.use(respond('get', LIST, 'analyses-list.json', 'history'));
    const { container } = renderHistory();
    const complete = (await rows())[1]!;
    expect(complete).toHaveTextContent('Complete');
    expect(complete).toHaveTextContent(/Readers describe a fast, tense survival story/);
    expect(complete).toHaveTextContent('Evidence confidence: High');
    expect(complete).toHaveTextContent('4.2/ 5');
    expect(complete).toHaveTextContent('Similarity to your taste, not a probability of enjoyment.');
    expect(complete).toHaveTextContent('Evidence confidence: Medium');
    expect(complete).toHaveTextContent('Model B4 (hybrid model)');
    expect(container.textContent).not.toMatch(/%/);
  });

  it('RES-4, MODEL-4: a failed row never says "no reviews", and below the floor shows no score', async () => {
    server.use(respond('get', LIST, 'analyses-list.json', 'history'));
    renderHistory();
    const items = await rows();
    expect(items[2]).toHaveTextContent('Limited evidence');
    expect(items[3]).toHaveTextContent(
      'Review sources could not be reached. This does not mean there are no reviews.',
    );
    expect(items[3]).toHaveTextContent('Not made, because the public reception did not finish.');
    expect(items[4]).toHaveTextContent('Not enough rated books yet for a personal match.');
    expect(items[4]).not.toHaveTextContent('/ 5');
    expect(items[5]).toHaveTextContent('Fallback model B1 (questionnaire and trait match)');
  });

  it('ONB-4: only an outdated row offers recalculation, naming both versions, and opens the new analysis', async () => {
    const page = history();
    server.use(
      http.get(`${API_URL}${LIST}`, () => HttpResponse.json(page)),
      respond(
        'post',
        `${LIST}/${page.items[6]!.id}/recalculate`,
        'analyses-recalculate.json',
        'recalculated',
      ),
    );
    renderHistory();
    const items = await rows();
    expect(screen.getAllByRole('button', { name: 'Recalculate' })).toHaveLength(1);
    const outdated = items[6]!;
    expect(outdated).toHaveTextContent('used taste profile version 3; yours is now version 4');
    await userEvent.click(within(outdated).getByRole('button', { name: 'Recalculate' }));
    const created = fixture('analyses-recalculate.json', 'recalculated').body as { id: string };
    expect(router.push).toHaveBeenCalledWith(`/analyses/${created.id}`);
  });

  it('ONB-4: a result made before any rating says so instead of naming a version', async () => {
    const page = history();
    const early = page.items[4]!;
    early.personalMatch = {
      ...early.personalMatch,
      status: 'needs_taste_data',
      tasteProfileVersion: null,
      currentTasteProfileVersion: 2,
      isOutdated: true,
    };
    page.items = [early];
    server.use(http.get(`${API_URL}${LIST}`, () => HttpResponse.json(page)));
    renderHistory();
    const [row] = await rows();
    expect(row).toHaveTextContent(
      'This result was made before you had rated any books; your taste profile is now version 2.',
    );
    expect(within(row!).getByRole('button', { name: 'Recalculate' })).toBeVisible();
  });

  it('shows a refused recalculation on its row', async () => {
    const page = history();
    server.use(
      http.get(`${API_URL}${LIST}`, () => HttpResponse.json(page)),
      respond(
        'post',
        `${LIST}/${page.items[6]!.id}/recalculate`,
        'analyses-recalculate.json',
        'rateLimited',
      ),
    );
    renderHistory();
    const outdated = (await rows())[6]!;
    await userEvent.click(within(outdated).getByRole('button', { name: 'Recalculate' }));
    expect(await within(outdated).findByRole('alert')).toHaveTextContent('Too many attempts');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('loads the next page with the cursor the API gave, and stops when there is none', async () => {
    const first = history();
    const extra = structuredClone(first.items[1]!);
    extra.id = '9d0c4c5e-7a0f-4d55-8d4e-0c7c1d7a1a11';
    extra.edition.title = 'Older Book';
    const cursors: Array<string | null> = [];
    server.use(
      http.get(`${API_URL}${LIST}`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(cursor ? { items: [extra], nextCursor: null } : first);
      }),
    );
    renderHistory();
    expect(await rows()).toHaveLength(first.items.length);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: 'Older Book' })).toBeVisible();
    expect(await rows()).toHaveLength(first.items.length + 1);
    expect(cursors.filter(Boolean)).toEqual([first.nextCursor]);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('with no analyses, says so and points to discovery', async () => {
    server.use(respond('get', LIST, 'analyses-list.json', 'empty'));
    renderHistory();
    expect(await screen.findByText('No analyses yet')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Find a book' })).toHaveAttribute('href', '/');
  });

  it('offers to try again when the history cannot be loaded', async () => {
    let fail = true;
    server.use(
      http.get(`${API_URL}${LIST}`, () =>
        fail
          ? HttpResponse.error()
          : HttpResponse.json(fixture('analyses-list.json', 'empty').body),
      ),
    );
    renderHistory();
    expect(await screen.findByText(/We cannot reach Bookie right now/)).toBeVisible();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No analyses yet')).toBeVisible();
  });
});
