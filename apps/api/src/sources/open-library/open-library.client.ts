/**
 * Open Library search (D-003: metadata and covers, cached, at most one
 * request per second, identified by a User-Agent). Used when the catalog has
 * no good match (spec 6). Responses are untrusted: every field is checked,
 * trimmed and capped.
 */
export interface OpenLibraryEdition {
  /** Edition key, e.g. "OL35547833M". */
  key: string;
  title: string;
  subtitle: string | null;
  /** Raw language code from Open Library (ISO 639-2, e.g. "eng"). */
  language: string | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  year: number | null;
  format: string | null;
  coverId: number | null;
}

export interface OpenLibraryWork {
  /** Work key, e.g. "OL25803688W". */
  key: string;
  title: string;
  authors: Array<{ key: string | null; name: string }>;
  firstPublishYear: number | null;
  /** The edition Open Library ranks best for the query (and language). */
  edition: OpenLibraryEdition | null;
}

export type SourceFailure = 'failed' | 'rate_limited';

export class SourceError extends Error {
  constructor(
    readonly outcome: SourceFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface OpenLibraryOptions {
  userAgent: string;
  timeoutMs: number;
  minIntervalMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const FIELDS = [
  'key',
  'title',
  'author_name',
  'author_key',
  'first_publish_year',
  'editions',
  'editions.key',
  'editions.title',
  'editions.subtitle',
  'editions.language',
  'editions.isbn',
  'editions.publish_date',
  'editions.publisher',
  'editions.cover_i',
  'editions.physical_format',
].join(',');

const MAX_TEXT = 500;

export class OpenLibraryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextSlot = 0;

  constructor(private readonly options: OpenLibraryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Searches works. `language` (ISO 639-1) asks Open Library to prefer editions in it. */
  async searchWorks(
    query: string,
    options: { limit: number; language?: string },
  ): Promise<OpenLibraryWork[]> {
    const url = new URL('/search.json', this.options.baseUrl ?? 'https://openlibrary.org');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(options.limit));
    url.searchParams.set('fields', FIELDS);
    if (options.language) url.searchParams.set('lang', options.language);
    const body = (await this.get(url)) as { docs?: unknown };
    if (!Array.isArray(body.docs)) throw new SourceError('failed', 'Unexpected response shape');
    return body.docs.map(parseWork).filter((w): w is OpenLibraryWork => w !== null);
  }

  private async get(url: URL): Promise<unknown> {
    // One request at a time, spaced by the minimum interval.
    const now = this.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.options.minIntervalMs;
    if (wait > 0) await this.sleep(wait);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new SourceError(
        'failed',
        controller.signal.aborted ? 'Timed out' : `Network error: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429) throw new SourceError('rate_limited', 'HTTP 429');
    if (!response.ok) throw new SourceError('failed', `HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new SourceError('failed', 'Response is not JSON');
    }
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
  return cleaned === '' ? null : cleaned;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function olKey(value: unknown, kind: 'W' | 'M' | 'A'): string | null {
  const match = typeof value === 'string' ? /(OL\d+[WMA])$/.exec(value) : null;
  return match && match[1]!.endsWith(kind) ? match[1]! : null;
}

function yearOf(value: unknown): number | null {
  const match = typeof value === 'string' ? /\b(1[4-9]\d\d|20\d\d)\b/.exec(value) : null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return match ? Number(match[1]) : null;
}

function parseEdition(value: unknown): OpenLibraryEdition | null {
  const e = value as Record<string, unknown> | null;
  const key = olKey(e?.key, 'M');
  const title = text(e?.title);
  if (!e || !key || !title) return null;
  const isbns = Array.isArray(e.isbn)
    ? e.isbn.filter((i): i is string => typeof i === 'string')
    : [];
  const cover = first(e.cover_i) ?? e.cover_i;
  return {
    key,
    title,
    subtitle: text(e.subtitle),
    language: text(first(e.language)),
    isbn13: isbns.find((i) => /^97[89]\d{10}$/.test(i)) ?? null,
    isbn10: isbns.find((i) => /^\d{9}[\dX]$/.test(i)) ?? null,
    publisher: text(first(e.publisher)),
    year: yearOf(first(e.publish_date)),
    format: text(e.physical_format),
    coverId: typeof cover === 'number' && Number.isInteger(cover) && cover > 0 ? cover : null,
  };
}

function parseWork(value: unknown): OpenLibraryWork | null {
  const d = value as Record<string, unknown> | null;
  const key = olKey(d?.key, 'W');
  const title = text(d?.title);
  if (!d || !key || !title) return null;
  const names = Array.isArray(d.author_name) ? d.author_name : [];
  const keys = Array.isArray(d.author_key) ? d.author_key : [];
  const authors = names
    .map((name, i) => ({ key: olKey(keys[i], 'A'), name: text(name) }))
    .filter((a): a is { key: string | null; name: string } => a.name !== null)
    .slice(0, 10);
  const editions = (d.editions as { docs?: unknown } | undefined)?.docs;
  return {
    key,
    title,
    authors,
    firstPublishYear: yearOf(d.first_publish_year),
    edition: parseEdition(first(editions)),
  };
}
