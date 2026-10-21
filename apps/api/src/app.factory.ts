import type { LoggerService, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import type { AppConfig } from './config/app-config';

export const API_PREFIX = 'api/v1';

/**
 * Builds the configured app without listening. Shared by main.ts, the e2e
 * tests and the OpenAPI generator so all three see the same setup.
 */
export async function createApp(
  config: AppConfig,
  options: { logger?: LoggerService | LogLevel[] | false } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: options.logger,
  });
  configureApp(app, config);
  return app;
}

/** App-wide settings. Tests that override providers call this on their own app. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.disable('x-powered-by');
  // Per-IP throttling needs the real client address behind a reverse proxy.
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
}
