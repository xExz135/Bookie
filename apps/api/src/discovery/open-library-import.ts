import { Injectable } from '@nestjs/common';
import { toBcp47 } from '../catalog/language';
import { normalizeForSearch } from '../catalog/normalize';
import { deterministicUuid } from '../common/deterministic-id';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import type { OpenLibraryWork } from '../sources/open-library/open-library.client';

export const OPEN_LIBRARY_SOURCE_KEY = 'open_library';

/** A catalog book counts as the same book at this title match and author match. */
const SAME_TITLE = 0.9;
const SAME_AUTHOR = 0.8;

/**
 * Adds Open Library search results to the catalog so they get an edition id
 * and can be confirmed and analysed like any other book (spec 6).
 *
 * A result is not added when the catalog already has the book, matched by
 * ISBN or by near-identical title and author; the Open Library work id is
 * linked to the existing work instead (for its ratings later, BE-5).
 * IDs are name-based, so the same result is never added twice.
 */
@Injectable()
export class OpenLibraryImport {
  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  /** Returns how many works were added and how many were already in the catalog. */
  async importWorks(works: OpenLibraryWork[]): Promise<{ added: number; linked: number }> {
    let added = 0;
    let linked = 0;
    for (const work of works) {
      if (!work.edition) continue;
      const result = await this.importOne(work, work.edition);
      if (result === 'added') added++;
      else linked++;
    }
    return { added, linked };
  }

  private async importOne(
    work: OpenLibraryWork,
    edition: NonNullable<OpenLibraryWork['edition']>,
  ): Promise<'added' | 'linked'> {
    const authorNames = work.authors.map((a) => a.name);
    const normalizedTitle = normalizeForSearch(edition.title);
    const normalizedAuthors = normalizeForSearch(authorNames.join(' '));
    const firstAuthor = normalizeForSearch(authorNames[0] ?? '');

    return this.prisma.$transaction(async (tx) => {
      const [source] = await tx.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT id FROM review_sources WHERE key = $1`,
        OPEN_LIBRARY_SOURCE_KEY,
      );
      if (!source) throw new Error('review_sources has no open_library row; run the migrations');

      const [existing] = await tx.$queryRawUnsafe<Array<{ work_id: string }>>(
        `SELECT work_id FROM editions
          WHERE ($1::text IS NOT NULL AND isbn_13 = $1)
             OR ($2::text IS NOT NULL AND isbn_10 = $2)
             OR (normalized_title % $3
                 AND similarity(normalized_title, $3) >= $4
                 AND ($5 = '' OR word_similarity($5, normalized_authors) >= $6))
          ORDER BY (isbn_13 = $1) DESC NULLS LAST, similarity(normalized_title, $3) DESC, id
          LIMIT 1`,
        edition.isbn13,
        edition.isbn10,
        normalizedTitle,
        SAME_TITLE,
        firstAuthor,
        SAME_AUTHOR,
      );
      if (existing) {
        await tx.$executeRawUnsafe(
          `INSERT INTO work_external_ids (work_id, source_id, external_id) VALUES ($1::uuid, $2, $3)
           ON CONFLICT DO NOTHING`,
          existing.work_id,
          source.id,
          work.key,
        );
        return 'linked';
      }

      const workId = deterministicUuid(`openlibrary:work:${work.key}`);
      const editionId = deterministicUuid(`openlibrary:edition:${edition.key}`);
      const expires = new Date(Date.now() + this.config.CACHE_METADATA_TTL_DAYS * 86_400_000);

      await tx.$executeRawUnsafe(
        `INSERT INTO works (id, title, original_publication_year, updated_at)
         VALUES ($1::uuid, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
        workId,
        work.title,
        work.firstPublishYear,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO work_external_ids (work_id, source_id, external_id) VALUES ($1::uuid, $2, $3)
         ON CONFLICT DO NOTHING`,
        workId,
        source.id,
        work.key,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO editions (id, work_id, title, subtitle, language, publisher, publication_year,
           format, isbn_10, isbn_13, cover_url, normalized_title, normalized_authors,
           metadata_expires_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
         ON CONFLICT (id) DO NOTHING`,
        editionId,
        workId,
        edition.title,
        edition.subtitle,
        edition.language ? toBcp47(edition.language) : null,
        edition.publisher,
        edition.year,
        edition.format,
        edition.isbn10,
        edition.isbn13,
        edition.coverId ? `https://covers.openlibrary.org/b/id/${edition.coverId}-M.jpg` : null,
        normalizedTitle,
        normalizedAuthors,
        expires,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO edition_external_ids (edition_id, source_id, external_id) VALUES ($1::uuid, $2, $3)
         ON CONFLICT DO NOTHING`,
        editionId,
        source.id,
        edition.key,
      );
      for (const [position, author] of work.authors.entries()) {
        const authorId = deterministicUuid(
          author.key
            ? `openlibrary:author:${author.key}`
            : `openlibrary:author-name:${normalizeForSearch(author.name)}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO authors (id, name, normalized_name) VALUES ($1::uuid, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          authorId,
          author.name,
          normalizeForSearch(author.name),
        );
        if (author.key) {
          await tx.$executeRawUnsafe(
            `INSERT INTO author_external_ids (author_id, source_id, external_id)
             VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING`,
            authorId,
            source.id,
            author.key,
          );
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO edition_authors (edition_id, author_id, position) VALUES ($1::uuid, $2::uuid, $3)
           ON CONFLICT DO NOTHING`,
          editionId,
          authorId,
          position + 1,
        );
      }
      return 'added';
    });
  }
}
