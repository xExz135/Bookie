import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { loadConfig } from './config/app-config';
import { findRepoRoot } from './repo-root';

async function bootstrap(): Promise<void> {
  const envFile = join(findRepoRoot(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadConfig();
  if (!process.env.AUTH_TOKEN_SECRET) {
    Logger.warn('AUTH_TOKEN_SECRET is not set: using a random one. Sessions end on restart.');
  }

  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
  Logger.log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
