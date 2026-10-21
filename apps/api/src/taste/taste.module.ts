import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { RatingImportService } from './rating-import.service';
import { TasteProfileService } from './taste-profile.service';
import { TasteController } from './taste.controller';
import { TasteService } from './taste.service';

@Module({
  imports: [
    DiscoveryModule,
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      // No storage option: the export stays in memory and is dropped after
      // parsing; only title, author and rating are kept (spec 12).
      useFactory: (config: AppConfig) => ({
        limits: { fileSize: config.IMPORT_MAX_BYTES, files: 1, fields: 0, parts: 1 },
      }),
    }),
  ],
  controllers: [TasteController],
  providers: [TasteService, TasteProfileService, RatingImportService],
  exports: [TasteProfileService],
})
export class TasteModule {}
