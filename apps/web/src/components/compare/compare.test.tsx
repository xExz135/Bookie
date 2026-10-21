import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import { API_URL } from '@/lib/config';
import type { Comparison } from '@/lib/reading-list/api';
import { fixture } from '@/test/fixtures';
import { respond, server } from '@/test/server';
import { Compare } from './compare';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const COMPARE = `${API_URL}/api/v1/compare`;
const A = '0b10b26f-04e1-598b-a2ac-cdac933ae226';
const B = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const compared = () =>
  structuredClone(fixture('compare.json', 'compared').body) as unknown as Comparison;

function serve(body: Comparison) {
  const asked: Array<[string | null, string | null]> = [];
  server.use(
    http.get(COMPARE, ({ request }) => {
      const url = new URL(request.url);
      asked.push([url.searchParams.get('a'), url.searchParams.get('b')]);
      return HttpResponse.json(body);
    }),
  );
  return asked;
}

function renderCompare(a: string | null = A, b: string | null = B) {
  return render(
    <StrictMode>
      <Compare a={a} b={b} />
    </StrictMode>,
  );
}

beforeEach(() => {
  session.clear();
});

describe('Compare (FE-8)', () => {
  it('spec 6: shows both books, each with its own public reception and personal match', async () => {
    const asked = serve(compared());
    renderCompare();
    const pub = await screen.findByRole('region', { name: 'Public reception' });
    expect(asked[0]).toEqual([A, B]);
    expect(within(pub).getByRole('heading', { name: 'The Hunger Games' })).toBeVisible();
    expect(within(pub).getByRole('heading', { name: 'Divergent' })).toBeVisible();
    expect(within(pub).getAllByText(/Readers describe/)).toHaveLength(2);

    const personal = screen.getByRole('region', { name: 'Your personal match' });
    expect(personal).toHaveTextContent('4.2/ 5');
    expect(personal).toHaveTextContent('3.8/ 5');
    expect(within(personal).getAllByText('Evidence confidence: Medium')).toHaveLength(2);
    expect(screen.getByText(/It is not a probability that you will enjoy it/)).toBeVisible();
    expect(document.body).not.toHaveTextContent('%');

    expect(
      screen.getByRole('link', { name: /Open the result\s*for The Hunger Games/ }),
    ).toHaveAttribute('href', `/analyses/${A}`);
    expect(screen.getByRole('link', { name: /Open the result\s*for Divergent/ })).toHaveAttribute(
      'href',
      `/analyses/${B}`,
    );
  });

  it('lists the traits that differ as the API sends them, with an empty side as unknown', async () => {
    const body = compared();
    body.traitDifferences.push({ trait: 'pace', a: ['fast'], b: [] });
    serve(body);
    renderCompare();
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Trait', 'The Hunger Games', 'Divergent']);
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => Array.from(row.querySelectorAll('th, td'), (c) => c.textContent));
    expect(rows).toEqual([
      ['Tone', 'tense', 'hopeful'],
      ['Themes', 'survival, power and politics, violence', 'identity, power and politics'],
      ['Content intensity', 'high', 'moderate'],
      ['Pace', 'fast', 'Unknown'],
    ]);
  });

  it('says when the traits do not differ', async () => {
    const body = compared();
    body.traitDifferences = [];
    serve(body);
    renderCompare();
    expect(await screen.findByText(/No differences/)).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says why a book has no personal match', async () => {
    const body = compared();
    const failed = structuredClone(fixture('analyses-get.json', 'personalUnavailable').body);
    body.b = { ...(failed as unknown as Comparison['b']), id: B };
    serve(body);
    renderCompare();
    const personal = await screen.findByRole('region', { name: 'Your personal match' });
    expect(personal).toHaveTextContent('4.2/ 5');
    expect(personal).toHaveTextContent('Personal matching is not available yet.');
  });

  it('asks for two books when the link names fewer, without calling the API', async () => {
    const asked = serve(compared());
    renderCompare(A, null);
    expect(await screen.findByText(/Choose two analyzed books/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the reading list' })).toHaveAttribute(
      'href',
      '/reading-list',
    );
    expect(asked).toEqual([]);
  });

  it('asks for two different books when the same one is named twice', async () => {
    server.use(respond('get', '/api/v1/compare', 'compare.json', 'sameAnalysis'));
    renderCompare(A, A);
    expect(
      await screen.findByText('Choose two different analyzed books to compare.'),
    ).toBeVisible();
  });

  it("does not show another reader's result", async () => {
    server.use(respond('get', '/api/v1/compare', 'compare.json', 'notYours'));
    renderCompare();
    expect(await screen.findByText(/One of these results could not be found/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Public reception' })).toBeNull();
  });

  it('says when the comparison cannot be loaded, and tries again', async () => {
    let calls = 0;
    server.use(
      http.get(COMPARE, () => {
        calls += 1;
        return calls === 1 ? HttpResponse.error() : HttpResponse.json(compared());
      }),
    );
    render(<Compare a={A} b={B} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/We cannot reach Bookie right now/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Public reception' })).toBeVisible();
  });
});
