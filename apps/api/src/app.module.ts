import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config)],
      controllers: [HealthController],
    };
  }
}
