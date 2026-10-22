import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import { API_URL } from '@/lib/config';
import { fitWithin } from '@/lib/discovery/encode-jpeg';
import { fixture } from '@/test/fixtures';
import { router, setLocation } from '@/test/navigation';
import { respond, server } from '@/test/server';
import { Discover } from './discover';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

// Canvas does not exist in jsdom; the resize step is replaced, the checks around it are real.
const encode = vi.hoisted(() => ({ jpeg: vi.fn() }));
vi.mock('@/lib/discovery/encode-jpeg', async (original) => ({
  ...(await original<typeof import('@/lib/discovery/encode-jpeg')>()),
  encodeJpeg: encode.jpeg,
}));

const SEARCH = '/api/v1/books/search';
const SCAN = '/api/v1/scan';
const ANALYSES = '/api/v1/analyses';

type Candidates = Array<{ editionId: string; title: string }>;
const ambiguous = fixture('books-search.json', 'ambiguous').body as { candidates: Candidates };
const twoMatches = fixture('scan.json', 'uncertainTwoMatches').body as { candidates: Candidates };
const started = fixture('analyses-start.json', 'started').body as { id: string };

function renderPage() {
  return render(
    <StrictMode>
      <Discover />
    </StrictMode>,
  );
}

async function searchFor(text: string) {
  const box = screen.getByLabelText('Title, author or ISBN');
  await userEvent.clear(box);
  await userEvent.type(box, text);
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
}

const photo = () => new File([new Uint8Array(5000)], 'cover.heic', { type: 'image/heic' });

async function scanPhoto(file: File = photo(), options = {}) {
  await userEvent.setup(options).upload(screen.getByLabelText('Choose a photo'), file);
}

/** Records what reached the API. */
function recordRequests() {
  const seen: Array<{ method: string; path: string }> = [];
  server.events.on('request:start', ({ request }) => {
    seen.push({ method: request.method, path: new URL(request.url).pathname });
  });
  return seen;
}

beforeEach(() => {
  router.push.mockReset();
  session.clear();
  setLocation('/');
  server.events.removeAllListeners();
  encode.jpeg.mockReset();
  encode.jpeg.mockResolvedValue(new Blob([new Uint8Array(200_000)], { type: 'image/jpeg' }));
});

describe('Typed search', () => {
  it('DISC-1: an ambiguous query shows candidate cards with every identifying field the API returned', async () => {
    let asked: string | null = null;
    server.use(
      http.get(`${API_URL}${SEARCH}`, ({ request }) => {
        asked = new URL(request.url).searchParams.get('q');
        return HttpResponse.json(ambiguous);
      }),
    );
    renderPage();
    await searchFor('  harry potter ');

    expect(await screen.findByRole('heading', { name: 'Which book do you mean?' })).toHaveFocus();
    expect(asked).toBe('harry potter');
    const cards = screen.getAllByRole('radio');
    expect(cards).toHaveLength(3);

    const first = within(
      screen.getByText("Harry Potter and the Sorcerer's Stone").closest('label')!,
    );
    expect(first.getByText('J.K. Rowling')).toBeInTheDocument();
    expect(first.getByText('Hardcover')).toBeInTheDocument();
    expect(first.getByText('English')).toBeInTheDocument();
    expect(first.getByText('1997')).toBeInTheDocument();
    expect(first.getByText('Scholastic Inc')).toBeInTheDocument();
    expect(
      first.getByRole('img', { name: "Cover of Harry Potter and the Sorcerer's Stone" }),
    ).toHaveAttribute('src', 'https://images.gr-assets.com/books/1474154022m/3.jpg');
    // A missing cover is said, not left as a broken image; unknown fields never print "null".
    expect(
      screen.getByRole('img', {
        name: 'No cover available for Harry Potter and the Chamber of Secrets',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it('shows "No cover" when a cover link no longer loads, not an empty box', async () => {
    server.use(respond('get', SEARCH, 'books-search.json', 'ambiguous'));
    renderPage();
    await searchFor('harry potter');
    const cover = await screen.findByRole('img', {
      name: "Cover of Harry Potter and the Sorcerer's Stone",
    });
    fireEvent.error(cover);
    expect(
      screen.getByRole('img', {
        name: "No cover available for Harry Potter and the Sorcerer's Stone",
      }),
    ).toBeInTheDocument();
  });

  it('never auto-selects between several books: the button waits for the reader', async () => {
    server.use(respond('get', SEARCH, 'books-search.json', 'ambiguous'));
    renderPage();
    await searchFor('harry potter');
    await screen.findByRole('heading', { name: 'Which book do you mean?' });
    expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Analyze this book' })).toBeDisabled();
    expect(screen.getByText('Choose a book to continue.')).toBeInTheDocument();
  });

  it('shows a book found on Open Library like any other', async () => {
    server.use(respond('get', SEARCH, 'books-search.json', 'foundOnOpenLibrary'));
    renderPage();
    await searchFor('the employees olga ravn');
    const card = within((await screen.findByRole('radio')).closest('label')!);
    expect(card.getByText('The Employees')).toBeInTheDocument();
    expect(card.getByText('A workplace novel of the 22nd century')).toBeInTheDocument();
    expect(
      screen.getByText('One book matches “the employees olga ravn”. Choose yours to continue.'),
    ).toBeInTheDocument();
  });

  it('says plainly when nothing matches', async () => {
    server.use(respond('get', SEARCH, 'books-search.json', 'noMatch'));
    renderPage();
    await searchFor('zxqv plorbing');
    expect(await screen.findByRole('heading', { name: 'No books found' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing matches “zxqv plorbing”/)).toBeInTheDocument();
  });

  it('never says "no such book" when Open Library could not be checked (spec 8)', async () => {
    server.use(respond('get', SEARCH, 'books-search.json', 'noMatchOpenLibraryFailed'));
    renderPage();
    await searchFor('some rare book');
    expect(await screen.findByText(/this book may still exist/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  it('checks the length before asking the API, and shows the API field message too', async () => {
    const seen = recordRequests();
    renderPage();
    await searchFor('a');
    expect(screen.getByText('Type at least 2 letters or digits.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title, author or ISBN')).toHaveFocus();
    expect(seen).toEqual([]);

    server.use(respond('get', SEARCH, 'books-search.json', 'validationFailed'));
    await searchFor('a!');
    expect(await screen.findByText('Type at least 2 letters or digits.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title, author or ISBN')).toHaveAttribute('aria-invalid', 'true');
  });

  it('maps a rate limit and a lost connection to their messages', async () => {
    server.use(respond('get', SEARCH, 'books-search.json', 'rateLimited'));
    renderPage();
    await searchFor('dune');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in a minute.',
    );

    server.use(http.get(`${API_URL}${SEARCH}`, () => HttpResponse.error()));
    await searchFor('dune');
    expect(await screen.findByRole('alert')).toHaveTextContent('We cannot reach Bookie right now');
  });
});

describe('Cover scan', () => {
  it('resizes the photo to JPEG on the device and uploads only that (spec 6)', async () => {
    // jsdom cannot stream a multipart body to the mock, so the form is checked as it is built.
    const append = vi.spyOn(FormData.prototype, 'append');
    let contentType: string | null = null;
    server.use(
      http.post(`${API_URL}${SCAN}`, ({ request }) => {
        contentType = request.headers.get('content-type');
        return HttpResponse.json(fixture('scan.json', 'identified').body as object);
      }),
    );
    renderPage();
    await scanPhoto();
    await screen.findByRole('heading', { name: 'Is this your book?' });
    expect(encode.jpeg).toHaveBeenCalledWith(expect.any(File), { maxPx: 1024, quality: 0.85 });
    expect(append).toHaveBeenCalledTimes(1);
    const [field, file] = append.mock.calls[0]!;
    expect(field).toBe('image');
    expect(file).toBe(await encode.jpeg.mock.results[0]!.value);
    expect((file as Blob).type).toBe('image/jpeg');
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    append.mockRestore();
  });

  it('identified: one book, chosen for the reader to check, still confirmed by a click', async () => {
    server.use(respond('post', SCAN, 'scan.json', 'identified'));
    renderPage();
    await scanPhoto();
    expect(await screen.findByRole('heading', { name: 'Is this your book?' })).toHaveFocus();
    expect(
      screen.getByText(/The cover reads “PROJECT HAIL MARY” by ANDY WEIR/),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio')).toBeChecked();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('DISC-2: an uncertain scan with several matches ends on the confirmation screen, nothing chosen', async () => {
    server.use(respond('post', SCAN, 'scan.json', 'uncertainTwoMatches'));
    renderPage();
    await scanPhoto();
    expect(await screen.findByRole('heading', { name: 'Which book is it?' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Analyze this book' })).toBeDisabled();
    // Two editions of the same title are told apart by their edition details.
    expect(screen.getByText('German')).toBeInTheDocument();
    expect(screen.getByText('Fischer')).toBeInTheDocument();
  });

  it('DISC-2: an uncertain scan with no match offers a typed search filled in from the cover', async () => {
    server.use(respond('post', SCAN, 'scan.json', 'uncertainNoMatch'));
    renderPage();
    await scanPhoto();
    expect(
      await screen.findByRole('heading', { name: 'We could not match this cover' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title, author or ISBN')).toHaveValue('THE QUIET HOURS PIA HOUR');
    await userEvent.click(screen.getByRole('button', { name: 'Edit the search' }));
    expect(screen.getByLabelText('Title, author or ISBN')).toHaveFocus();
  });

  it('"Not your book?" moves to typed search with what the cover said', async () => {
    server.use(respond('post', SCAN, 'scan.json', 'uncertainTwoMatches'));
    renderPage();
    await scanPhoto();
    await userEvent.click(await screen.findByRole('button', { name: 'Search by title instead' }));
    const box = screen.getByLabelText('Title, author or ISBN');
    expect(box).toHaveValue('GONE GIRL GILLIAN FLYNN');
    expect(box).toHaveFocus();
  });

  it('DISC-4: a file that is not a photo is refused on the device and never uploaded', async () => {
    const seen = recordRequests();
    renderPage();
    const pdf = new File(['%PDF-1.7'], 'cover.pdf', { type: 'application/pdf' });
    // Desktop file pickers can be switched to "All files", so the accept list is not enough.
    await scanPhoto(pdf, { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is not a photo');
    expect(encode.jpeg).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('DISC-4: a photo still too large after resizing is refused before upload', async () => {
    const seen = recordRequests();
    encode.jpeg.mockResolvedValue(
      new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' }),
    );
    renderPage();
    await scanPhoto();
    expect(await screen.findByRole('alert')).toHaveTextContent('That photo is too large');
    expect(seen).toEqual([]);
  });

  it('a photo the browser cannot open sends the reader to typed search', async () => {
    encode.jpeg.mockRejectedValue(new Error('decode failed'));
    renderPage();
    await scanPhoto();
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not open that photo');
    expect(screen.getByLabelText('Title, author or ISBN')).toHaveFocus();
  });

  it('DISC-4: the API refusing a file as too large or the wrong type is explained', async () => {
    renderPage();
    for (const [outcome, text] of [
      ['uploadTooLarge', 'That file is too large.'],
      ['unsupportedType', 'That type of file is not supported.'],
    ]) {
      server.use(respond('post', SCAN, 'scan.json', outcome!));
      await scanPhoto();
      expect(await screen.findByRole('alert')).toHaveTextContent(text!);
    }
  });

  it('not a book, or unreadable: dismissed with a prompt to type the title (spec 6)', async () => {
    renderPage();
    for (const [outcome, text] of [
      ['notABook', 'That does not look like a book cover. Try typing the title instead.'],
      ['unreadable', 'We could not read that photo. Try typing the title instead.'],
    ]) {
      server.use(respond('post', SCAN, 'scan.json', outcome!));
      await scanPhoto();
      expect(await screen.findByRole('alert')).toHaveTextContent(text!);
      expect(screen.getByLabelText('Title, author or ISBN')).toHaveFocus();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    }
  });

  it('identification down: says so, and typed search still works', async () => {
    server.use(
      http.post(`${API_URL}${SCAN}`, () =>
        HttpResponse.json(
          { code: 'IDENTIFICATION_UNAVAILABLE', message: 'Unavailable.', retryable: true },
          { status: 503 },
        ),
      ),
      respond('get', SEARCH, 'books-search.json', 'ambiguous'),
    );
    renderPage();
    await scanPhoto();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cover scanning is unavailable right now. Typed search still works.',
    );
    await searchFor('harry potter');
    expect(await screen.findAllByRole('radio')).toHaveLength(3);
  });

  it('daily scan limit: says when the next scan is free', async () => {
    server.use(respond('post', SCAN, 'scan.json', 'quotaExceeded'));
    renderPage();
    await scanPhoto();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You have used today's scans. Try again in 15 hours, or type the title.",
    );
  });
});

describe('Confirmation starts the analysis', () => {
  it('DISC-5: names the chosen edition, then starts its analysis and opens it', async () => {
    let body: unknown = null;
    server.use(
      respond('get', SEARCH, 'books-search.json', 'ambiguous'),
      http.post(`${API_URL}${ANALYSES}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(started as object, { status: 201 });
      }),
    );
    renderPage();
    await searchFor('harry potter');
    await userEvent.click(await screen.findByRole('radio', { name: /Prisoner of Azkaban/ }));
    expect(
      screen.getByText('· Mass Market Paperback · Scholastic Inc. · 2004 · English'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze this book' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/analyses/${started.id}`));
    expect(body).toEqual({ editionId: ambiguous.candidates[1]!.editionId });
  });

  it('FE-11: works with the keyboard alone: search, choose a book, start the analysis', async () => {
    let body: unknown = null;
    server.use(
      respond('get', SEARCH, 'books-search.json', 'ambiguous'),
      http.post(`${API_URL}${ANALYSES}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(started as object, { status: 201 });
      }),
    );
    renderPage();
    /** Presses Tab until the element is focused, as a keyboard reader would. */
    async function tabTo(element: HTMLElement) {
      for (let i = 0; i < 30 && document.activeElement !== element; i += 1) await userEvent.tab();
      expect(element).toHaveFocus();
    }
    await tabTo(screen.getByLabelText('Title, author or ISBN'));
    await userEvent.keyboard('harry potter{Enter}');
    const radios = await screen.findAllByRole('radio');
    await tabTo(radios[0]!);
    await userEvent.keyboard('{ArrowDown}');
    expect(radios[1]).toBeChecked();
    await tabTo(screen.getByRole('button', { name: 'Analyze this book' }));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/analyses/${started.id}`));
    expect(body).toEqual({ editionId: ambiguous.candidates[1]!.editionId });
  });

  it('joins an analysis already running for the book', async () => {
    server.use(
      respond('post', SCAN, 'scan.json', 'uncertainTwoMatches'),
      respond('post', ANALYSES, 'analyses-start.json', 'joinedRunning'),
    );
    renderPage();
    await scanPhoto();
    await userEvent.click((await screen.findAllByRole('radio'))[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Analyze this book' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/analyses/${started.id}`));
    expect(twoMatches.candidates).toHaveLength(2);
  });

  it('explains an unknown book or a rate limit, and lets the reader try again', async () => {
    server.use(
      respond('get', SEARCH, 'books-search.json', 'foundOnOpenLibrary'),
      respond('post', ANALYSES, 'analyses-start.json', 'unknownEdition'),
    );
    renderPage();
    await searchFor('the employees');
    await screen.findByRole('radio');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze this book' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not find that book any more. Please search again.',
    );

    server.use(respond('post', ANALYSES, 'analyses-start.json', 'rateLimited'));
    await userEvent.click(screen.getByRole('button', { name: 'Analyze this book' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('Resizing', () => {
  it('fits the longest side within the limit and never enlarges', () => {
    expect(fitWithin(4032, 3024, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3024, 4032, 1024)).toEqual({ width: 768, height: 1024 });
    expect(fitWithin(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });
});
