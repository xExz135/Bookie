import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { SourcesModule } from '../sources/sources.module';
import { BookSearchService } from './book-search.service';
import { CatalogSearch } from './catalog-search';
import { buildVisionReaders } from './cover-vision';
import { DiscoveryController } from './discovery.controller';
import { OpenLibraryImport } from './open-library-import';
import { COVER_VISION, ScanService } from './scan.service';
import { ScanQuota } from './scan-quota';

@Module({
  imports: [
    // The shared Open Library client (OPEN_LIBRARY).
    SourcesModule,
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
      provide: COVER_VISION,
      inject: [APP_CONFIG],
      // Groq first, Gemini as fallback by default (D-030).
      useFactory: (config: AppConfig) => buildVisionReaders(config),
    },
  ],
  exports: [BookSearchService, CatalogSearch],
})
export class DiscoveryModule {}
