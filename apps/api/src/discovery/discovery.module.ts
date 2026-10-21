import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { GeminiClient } from '../llm/gemini.client';
import { OpenLibraryClient } from '../sources/open-library/open-library.client';
import { BookSearchService, OPEN_LIBRARY } from './book-search.service';
import { CatalogSearch } from './catalog-search';
import { DiscoveryController } from './discovery.controller';
import { OpenLibraryImport } from './open-library-import';
import { COVER_VISION, ScanService } from './scan.service';
import { ScanQuota } from './scan-quota';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      // No storage option: multer keeps the file in memory (DISC-3). The size
      // limit stops the upload as soon as it is exceeded (DISC-4).
      useFactory: (config: AppConfig) => ({
        limits: { fileSize: config.SCAN_MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 2 },
      }),
    }),
  ],
  controllers: [DiscoveryController],
  providers: [
    BookSearchService,
    CatalogSearch,
    OpenLibraryImport,
    ScanQuota,
    ScanService,
    {
      provide: OPEN_LIBRARY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new OpenLibraryClient({
          userAgent: config.OPEN_LIBRARY_USER_AGENT,
          timeoutMs: config.SOURCE_TIMEOUT_MS,
          minIntervalMs: config.OPEN_LIBRARY_MIN_INTERVAL_MS,
        }),
    },
    {
      provide: COVER_VISION,
      inject: [APP_CONFIG],
      // Its own client: a scan should fail fast rather than wait a minute.
      useFactory: (config: AppConfig) =>
        new GeminiClient({
          apiKey: config.GEMINI_API_KEY,
          timeoutMs: config.SCAN_TIMEOUT_MS,
          maxRequestsPerMinute: config.GEMINI_MAX_REQUESTS_PER_MINUTE,
          tokensPerMinute: config.GEMINI_TOKENS_PER_MINUTE,
          transientRetries: 1,
        }),
    },
  ],
  exports: [BookSearchService, CatalogSearch],
})
export class DiscoveryModule {}
