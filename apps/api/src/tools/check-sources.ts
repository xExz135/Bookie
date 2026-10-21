/**
 * Asks every configured live rating source about real books, to repeat the
 * source audit (docs/DATA_SOURCES.md) and to measure match rates for the
 * D-020 thresholds.
 *
 *   pnpm --filter @bookie/api sources:check --limit 20          # the most-rated catalog books
 *   pnpm --filter @bookie/api sources:check --edition <uuid>
 *   pnpm --filter @bookie/api sources:check --title "The Employees" --author "Olga Ravn" [--isbn 9781999992880]
 *
 * Output: data/derived/sources-check-<time>.json (git-ignored). Numbers from
 * a source whose terms forbid storing them (Google Books) are printed but not
 * written to the file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../database/prisma.service';
import type { BookRef } from '../sources/rating-source';
import { type SourceRating, RatingSourcesService } from '../sources/rating-sources.service';
import { openLibraryClient, ratingAdapters } from '../sources/sources.module';
import { runCli, startCli, timestamp, wholeNumber } from './cli';

function line(r: SourceRating): string {
  if (r.outcome === 'ok')
    return `${r.name}: ${r.ratingAverage} from ${r.ratingCount} (${r.ratingScope}, by ${r.matchedBy}, ${r.durationMs} ms)`;
  return `${r.name}: ${r.outcome} (${r.detail}, ${r.durationMs} ms)`;
}

/** What may be written to disk: no numbers from a source that may not be stored. */
function storable(r: SourceRating): object {
  const { ratingAverage, ratingCount, ...rest } = r;
  return r.storageAllowed ? r : { ...rest, ratingAverage: null, ratingCount: null, withheld: true };
}

runCli(async () => {
  const { root, config, values } = startCli({
    limit: { type: 'string' },
    edition: { type: 'string' },
    title: { type: 'string' },
    author: { type: 'string' },
    isbn: { type: 'string' },
  });
  const prisma = new PrismaService(config);
  const adapters = ratingAdapters(config, openLibraryClient(config));
  for (const a of adapters) if (!a.configured) console.log(`${a.key}: not configured, not asked`);
  const service = new RatingSourcesService(prisma, config, adapters);

  try {
    const books: BookRef[] = [];
    if (values.title) {
      const isbn = values.isbn?.replace(/[^\dX]/gi, '') ?? null;
      books.push({
        editionId: 'ad-hoc',
        title: values.title,
        subtitle: null,
        authors: values.author ? [values.author] : [],
        isbn13: isbn && isbn.length === 13 ? isbn : null,
        isbn10: isbn && isbn.length === 10 ? isbn : null,
        openLibraryWorkKey: null,
      });
    } else if (values.edition) {
      const book = await service.loadBook(values.edition);
      if (!book) throw new Error(`No edition ${values.edition} in the catalog`);
      books.push(book);
    } else {
      const limit = wholeNumber(values.limit, '--limit', 10);
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT e.id FROM editions e
           LEFT JOIN review_fetches f ON f.edition_id = e.id AND f.reviews_version = 1
            AND f.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
          ORDER BY f.rating_count DESC NULLS LAST, e.id LIMIT $1`,
        limit,
      );
      for (const { id } of rows) {
        const book = await service.loadBook(id);
        if (book) books.push(book);
      }
    }

    const results: Array<{ book: BookRef; sources: object[] }> = [];
    const tally: Record<string, Record<string, number>> = {};
    for (const book of books) {
      const sources = await service.lookup(book);
      console.log(
        `${timestamp()} ${book.title} (${book.authors[0] ?? 'no author'}, ISBN ${book.isbn13 ?? book.isbn10 ?? 'none'})`,
      );
      for (const r of sources) {
        console.log(`    ${line(r)}`);
        const bucket = r.outcome === 'empty' ? `empty:${r.detail}` : r.outcome;
        tally[r.key] ??= {};
        tally[r.key]![bucket] = (tally[r.key]![bucket] ?? 0) + 1;
      }
      results.push({ book, sources: sources.map(storable) });
    }

    const summary = {
      books: books.length,
      thresholds: {
        minTitle: config.SOURCE_MATCH_MIN_TITLE,
        minAuthor: config.SOURCE_MATCH_MIN_AUTHOR,
      },
      outcomes: tally,
    };
    const dir = join(root, 'data', 'derived');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `sources-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Saved ${file}`);
  } finally {
    await prisma.$disconnect();
  }
});
