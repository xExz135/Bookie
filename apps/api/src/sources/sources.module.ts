import { Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { GoogleBooksRatings } from './google-books/google-books.client';
import { HardcoverRatings } from './hardcover/hardcover.client';
import { OpenLibraryRatings } from './open-library/open-library-ratings';
import { OpenLibraryClient } from './open-library/open-library.client';
import type { RatingSourceAdapter } from './rating-source';
import { RatingSourcesService } from './rating-sources.service';
import { OPEN_LIBRARY, RATING_SOURCES } from './sources.tokens';

/** Builds the three adapters from settings. Shared by the module and the check tool. */
export function ratingAdapters(
  config: AppConfig,
  openLibrary: OpenLibraryClient,
): RatingSourceAdapter[] {
  const match = {
    minTitle: config.SOURCE_MATCH_MIN_TITLE,
    minAuthor: config.SOURCE_MATCH_MIN_AUTHOR,
  };
  return [
    new OpenLibraryRatings(openLibrary, { ...match, searchResults: config.SOURCE_SEARCH_RESULTS }),
    new HardcoverRatings({
      ...match,
      token: config.HARDCOVER_API_TOKEN,
      userAgent: config.OPEN_LIBRARY_USER_AGENT,
      searchResults: config.SOURCE_SEARCH_RESULTS,
      timeoutMs: config.SOURCE_TIMEOUT_MS,
      minIntervalMs: config.HARDCOVER_MIN_INTERVAL_MS,
    }),
    new GoogleBooksRatings({
      ...match,
      enabled: config.GOOGLE_BOOKS_ENABLED,
      apiKey: config.GOOGLE_BOOKS_API_KEY,
      maxResults: config.GOOGLE_BOOKS_MAX_RESULTS,
      timeoutMs: config.SOURCE_TIMEOUT_MS,
      minIntervalMs: config.GOOGLE_BOOKS_MIN_INTERVAL_MS,
    }),
  ];
}

export function openLibraryClient(config: AppConfig): OpenLibraryClient {
  return new OpenLibraryClient({
    userAgent: config.OPEN_LIBRARY_USER_AGENT,
    timeoutMs: config.SOURCE_TIMEOUT_MS,
    minIntervalMs: config.OPEN_LIBRARY_MIN_INTERVAL_MS,
  });
}

/**
 * Live sources (D-003). One Open Library client for the whole app, so search
 * (BE-6) and ratings (BE-5) share its one-request-per-second spacing.
 */
@Module({
  providers: [
    { provide: OPEN_LIBRARY, inject: [APP_CONFIG], useFactory: openLibraryClient },
    {
      provide: RATING_SOURCES,
      inject: [APP_CONFIG, OPEN_LIBRARY],
      useFactory: ratingAdapters,
    },
    RatingSourcesService,
  ],
  exports: [OPEN_LIBRARY, RatingSourcesService],
})
export class SourcesModule {}
