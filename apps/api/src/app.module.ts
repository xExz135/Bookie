import { type DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mailer';
import { RedisModule } from './redis/redis.module';

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
      ],
      controllers: [HealthController],
    };
  }
}
