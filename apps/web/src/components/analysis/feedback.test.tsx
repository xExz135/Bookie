import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/api/client';
import type { Analysis } from '@/lib/analysis/api';
import { API_URL } from '@/lib/config';
import { fixture } from '@/test/fixtures';
import { server } from '@/test/server';
import { AnalysisScreen } from './analysis-screen';

vi.mock('next/navigation', async () => (await import('@/test/navigation')).navigationMock);

const ID = '0b10b26f-04e1-598b-a2ac-cdac933ae226';
const FEEDBACK = `${API_URL}/api/v1/feedback`;
const PUBLIC_Q = 'Does this summary of reviews seem accurate to you?';
const PERSONAL_Q = 'Does this personal match feel right?';

function serve(name: string) {
  const body = structuredClone(fixture('analyses-get.json', name).body) as unknown as Analysis;
  if (body.pollAfterMs !== null) body.pollAfterMs = 20;
  server.use(http.get(`${API_URL}/api/v1/analyses/${ID}`, () => HttpResponse.json(body)));
  return body;
}

/** Answers PUT /feedback by echoing the choice, and records each request. */
function acceptFeedback() {
  const sent: unknown[] = [];
  server.use(
    http.put(FEEDBACK, async ({ request }) => {
      const body = (await request.json()) as { target: string; value: string };
      sent.push(body);
      return HttpResponse.json({
        target: body.target,
        value: body.value,
        updatedAt: '2026-10-21T09:00:00.000Z',
      });
    }),
  );
  return sent;
}

function renderScreen() {
  return render(
    <StrictMode>
      <AnalysisScreen id={ID} />
    </StrictMode>,
  );
}

const group = (name: string) => screen.getByRole('group', { name });
const pressed = (name: string) =>
  within(group(name))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);

beforeEach(() => {
  session.clear();
});

describe('Feedback controls (FE-6)', () => {
  it('FB-1: each section has its own Accurate / Not for me, showing the saved choice', async () => {
    serve('outdated');
    renderScreen();
    await screen.findByText('Complete');
    const pub = within(screen.getByRole('region', { name: 'Public reception' }));
    const personal = within(screen.getByRole('region', { name: 'Your personal match' }));
    expect(pub.getByRole('group', { name: PUBLIC_Q })).toBeVisible();
    expect(personal.getByRole('group', { name: PERSONAL_Q })).toBeVisible();
    expect(pressed(PUBLIC_Q)).toEqual(['Accurate']);
    expect(pressed(PERSONAL_Q)).toEqual(['Not for me']);
    expect(
      within(group(PUBLIC_Q))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Accurate', 'Not for me']);
  });

  it('FB-1: saves a choice for the right analysis and section, and can change it', async () => {
    serve('complete');
    const sent = acceptFeedback();
    renderScreen();
    await screen.findByText('Complete');
    expect(pressed(PERSONAL_Q)).toEqual([]);

    await userEvent.click(within(group(PERSONAL_Q)).getByRole('button', { name: 'Accurate' }));
    expect(
      await within(screen.getByRole('region', { name: 'Your personal match' })).findByText(
        /Saved\./,
      ),
    ).toBeVisible();
    expect(pressed(PERSONAL_Q)).toEqual(['Accurate']);

    await userEvent.click(within(group(PUBLIC_Q)).getByRole('button', { name: 'Not for me' }));
    await within(screen.getByRole('region', { name: 'Public reception' })).findByText(/Saved\./);
    expect(pressed(PUBLIC_Q)).toEqual(['Not for me']);
    await userEvent.click(within(group(PUBLIC_Q)).getByRole('button', { name: 'Accurate' }));
    await vi.waitFor(() => expect(pressed(PUBLIC_Q)).toEqual(['Accurate']));

    expect(sent).toEqual([
      { analysisId: ID, target: 'personal', value: 'accurate' },
      { analysisId: ID, target: 'public', value: 'not_for_me' },
      { analysisId: ID, target: 'public', value: 'accurate' },
    ]);
  });

  it('pressing the choice already saved sends nothing', async () => {
    serve('complete');
    const sent = acceptFeedback();
    renderScreen();
    await screen.findByText('Complete');
    expect(pressed(PUBLIC_Q)).toEqual(['Accurate']);
    await userEvent.click(within(group(PUBLIC_Q)).getByRole('button', { name: 'Accurate' }));
    expect(sent).toEqual([]);
  });

  it('spec 6: hidden on sections that failed or were not generated', async () => {
    serve('allSourcesFailed');
    renderScreen();
    await screen.findByText('Could not finish');
    expect(screen.queryByRole('group', { name: PUBLIC_Q })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: PERSONAL_Q })).not.toBeInTheDocument();
  });

  it.each(['personalUnavailable', 'belowFloor', 'needsTasteData', 'personalFailed'])(
    'spec 6: with no personal score (%s), only the public reception can be judged',
    async (name) => {
      serve(name);
      renderScreen();
      await screen.findByRole('group', { name: PUBLIC_Q });
      expect(screen.queryByRole('group', { name: PERSONAL_Q })).not.toBeInTheDocument();
    },
  );

  it('none while the analysis is still running', async () => {
    serve('running');
    renderScreen();
    await screen.findByText('Analyzing');
    expect(screen.queryByRole('group', { name: PUBLIC_Q })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: PERSONAL_Q })).not.toBeInTheDocument();
  });

  it('a refused save puts the earlier choice back and says why', async () => {
    serve('complete');
    server.use(
      http.put(FEEDBACK, () =>
        HttpResponse.json(fixture('feedback-put.json', 'sectionNotGenerated').body as object, {
          status: 409,
        }),
      ),
    );
    renderScreen();
    await screen.findByText('Complete');
    await userEvent.click(within(group(PUBLIC_Q)).getByRole('button', { name: 'Not for me' }));
    expect(
      await within(screen.getByRole('region', { name: 'Public reception' })).findByRole('alert'),
    ).toHaveTextContent('This section can no longer be rated.');
    expect(pressed(PUBLIC_Q)).toEqual(['Accurate']);
  });

  it('a lost connection keeps the earlier choice and says so', async () => {
    serve('complete');
    server.use(http.put(FEEDBACK, () => HttpResponse.error()));
    renderScreen();
    await screen.findByText('Complete');
    await userEvent.click(within(group(PERSONAL_Q)).getByRole('button', { name: 'Not for me' }));
    expect(
      await within(screen.getByRole('region', { name: 'Your personal match' })).findByRole('alert'),
    ).toHaveTextContent(/We cannot reach Bookie right now/);
    expect(pressed(PERSONAL_Q)).toEqual([]);
  });
});
