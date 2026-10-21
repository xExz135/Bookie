import { type DynamicModule, Module } from '@nestjs/common';
import { AnalysisModule } from './analysis/analysis.module';
import { AuthModule } from './auth/auth.module';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mailer';
import { ReaderDataModule } from './reader-data/reader-data.module';
import { RedisModule } from './redis/redis.module';
import { StudyModule } from './study/study.module';
import { TasteModule } from './taste/taste.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        RedisModule,
        MailModule,
        AuthModule,
        DiscoveryModule,
        TasteModule,
        AnalysisModule,
        ReaderDataModule,
        StudyModule,
      ],
      controllers: [HealthController],
    };
  }
}
