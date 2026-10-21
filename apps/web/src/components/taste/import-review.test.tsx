import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import { API_URL } from '@/lib/config';
import type { RatingImport } from '@/lib/taste/api';
import { fixture } from '@/test/fixtures';
import { server } from '@/test/server';
import { ImportReview } from './import-review';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const SEARCH = `${API_URL}/api/v1/books/search`;
const review = () =>
  structuredClone(
    fixture('ratings-import-get.json', 'needsReview').body,
  ) as unknown as RatingImport;
const found = fixture('books-search.json', 'foundOnOpenLibrary').body as {
  candidates: Array<{ editionId: string; title: string }>;
};

function renderReview(data: RatingImport = review()) {
  const onSave = vi.fn();
  render(
    <StrictMode>
      <ImportReview data={data} saving={false} error={null} onSave={onSave} onCancel={vi.fn()} />
    </StrictMode>,
  );
  return {
    onSave,
    rows: within(screen.getByRole('list', { name: 'Rows not matched' })).getAllByRole('listitem'),
  };
}

beforeEach(() => {
  session.clear();
});

describe('Import review (FE-3)', () => {
  it('ONB-1: lists every unmatched row with its suggestions, and chooses nothing for the reader', () => {
    const data = review();
    const { rows } = renderReview(data);
    expect(rows).toHaveLength(data.unmatched.length);
    const pride = within(rows[0]!).getByRole('group');
    expect(pride).toHaveAccessibleName(/Pride and Prejudice/);
    const options = within(pride).getAllByRole('radio');
    expect(options.map((o) => (o as HTMLInputElement).checked)).toEqual([false, false, true]);
    expect(within(pride).getByRole('radio', { name: /Modern Library · 2000/ })).toBeVisible();
    expect(within(pride).getByRole('radio', { name: 'Skip this row' })).toBeChecked();
    expect(within(rows[1]!).getByRole('radio', { name: 'Skip this row' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save 205 ratings' })).toBeEnabled();
  });

  it('ONB-1: saves the chosen suggestion and a book found by searching, and skips nothing else silently', async () => {
    const data = review();
    const asked: Array<string | null> = [];
    server.use(
      http.get(SEARCH, ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('q'));
        return HttpResponse.json(found);
      }),
    );
    const { onSave, rows } = renderReview(data);
    const pride = data.unmatched[0]!;
    const nobody = data.unmatched[1]!;

    await userEvent.click(within(rows[0]!).getByRole('radio', { name: /Modern Library · 2000/ }));
    // The search starts from the row's own title and author.
    const box = within(rows[1]!).getByRole('searchbox', {
      name: `Find the book for ${nobody.rawTitle}`,
    });
    expect(box).toHaveValue('A Book Nobody Has Small Press Author');
    await userEvent.clear(box);
    await userEvent.type(box, 'the employees{Enter}');
    const result = await within(rows[1]!).findByRole('radio', { name: /The Employees/ });
    expect(asked).toEqual(['the employees']);
    await userEvent.click(result);

    expect(screen.getByText(/207 ratings will be saved; 0 rows skipped/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save 207 ratings' }));
    expect(onSave).toHaveBeenCalledWith(
      [
        { rowIndex: pride.rowIndex, editionId: pride.candidates[0]!.editionId },
        { rowIndex: nobody.rowIndex, editionId: found.candidates[0]!.editionId },
      ],
      207,
    );
  });

  it('a row can go back to skipped after choosing a book', async () => {
    const data = review();
    const { onSave, rows } = renderReview(data);
    await userEvent.click(within(rows[0]!).getByRole('radio', { name: /Penguin · 2003/ }));
    expect(screen.getByRole('button', { name: 'Save 206 ratings' })).toBeVisible();
    await userEvent.click(within(rows[0]!).getByRole('radio', { name: 'Skip this row' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save 205 ratings' }));
    expect(onSave).toHaveBeenCalledWith(
      data.unmatched.map((row) => ({ rowIndex: row.rowIndex, skip: true })),
      205,
    );
  });

  it('says when a search finds nothing and Open Library could not be checked, never that the book does not exist', async () => {
    server.use(
      http.get(SEARCH, () =>
        HttpResponse.json(fixture('books-search.json', 'noMatchOpenLibraryFailed').body as object),
      ),
    );
    const { rows } = renderReview();
    await userEvent.click(within(rows[1]!).getByRole('button', { name: /^Search/ }));
    expect(
      await within(rows[1]!).findByText(
        /Open Library could not be checked just now, so the book may still exist/,
      ),
    ).toBeVisible();
    expect(within(rows[1]!).getAllByRole('radio')).toHaveLength(1);
  });

  it('shows a refused search on its row', async () => {
    server.use(
      http.get(SEARCH, () =>
        HttpResponse.json(fixture('books-search.json', 'rateLimited').body as object, {
          status: 429,
        }),
      ),
    );
    const { rows } = renderReview();
    await userEvent.click(within(rows[0]!).getByRole('button', { name: /^Search/ }));
    expect(await within(rows[0]!).findByText(/Too many attempts/)).toBeVisible();
  });

  it('with nothing matched and nothing chosen, there is nothing to save', () => {
    const data = review();
    data.matchedCount = 0;
    renderReview(data);
    expect(screen.getByRole('button', { name: 'Save 0 ratings' })).toBeDisabled();
    expect(screen.getByText(/Nothing is matched or chosen yet/)).toBeVisible();
  });
});
