import { SourceError } from './source-error';

export interface PacedHttpOptions {
  /** Time limit for one request. */
  timeoutMs: number;
  /** Minimum time between two requests to this source. */
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * HTTP for one live source: requests are spaced by a minimum interval (the
 * source's rate limit), each has a time limit, and network trouble becomes a
 * `SourceError` instead of an exception the caller could mistake for "empty".
 * Status codes other than 429 are left to the caller, which knows what they
 * mean for its source.
 */
export class PacedHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextSlot = 0;

  constructor(private readonly options: PacedHttpOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** `signal` lets the caller stop waiting, e.g. when its overall deadline passes. */
  async send(url: URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const now = this.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.options.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
    if (signal?.aborted) throw new SourceError('failed', 'Timed out', 'timeout');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (response.status === 429) throw new SourceError('rate_limited', 'HTTP 429');
      return response;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (controller.signal.aborted) throw new SourceError('failed', 'Timed out', 'timeout');
      throw new SourceError('failed', `Network error: ${(error as Error).message}`, 'network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
}

/** Reads a JSON body; anything else is a failed source, not an empty one. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SourceError('failed', 'Response is not JSON', 'bad_response');
  }
}
