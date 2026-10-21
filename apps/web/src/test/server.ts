import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API_URL } from '@/lib/config';
import { fixture } from './fixtures';

export const server = setupServer();

/** A handler that answers with one fixture outcome. */
export function respond(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  file: string,
  outcome: string,
) {
  const { status, body } = fixture(file, outcome);
  return http[method](`${API_URL}${path}`, () =>
    body === null ? new HttpResponse(null, { status }) : HttpResponse.json(body, { status }),
  );
}

/** Signed in: refresh works and /me returns the fixture user. */
export const signedIn = () => [
  respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'success'),
  respond('get', '/api/v1/me', 'me.json', 'success'),
];

/** Signed out: no valid refresh cookie. */
export const signedOut = () => [
  respond('post', '/api/v1/auth/refresh', 'auth-refresh.json', 'noValidRefreshCookie'),
];
