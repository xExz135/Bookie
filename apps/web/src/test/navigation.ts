import { vi } from 'vitest';

/** A stand-in for next/navigation, so pages can be rendered in tests. */
export const router = {
  replace: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};
export let searchParams = new URLSearchParams();
export let pathname = '/';

export function setLocation(path: string) {
  const url = new URL(path, 'http://localhost:3000');
  pathname = url.pathname;
  searchParams = url.searchParams;
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

export const navigationMock = {
  useRouter: () => router,
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
};
