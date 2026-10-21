import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { type AppConfig, loadConfig } from '../../src/config/app-config';
import { MAILER, type MailMessage, type Mailer } from '../../src/mail/mailer';
import { TEST_DATABASE_URL } from './test-database';

/** Records mail instead of sending it. */
export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** Waits for a message to `to` (mail is sent in the background). */
  async waitFor(to: string, timeoutMs = 2000): Promise<MailMessage> {
    const started = Date.now();
    for (;;) {
      const found = this.sent.find((m) => m.to === to);
      if (found) return found;
      if (Date.now() - started > timeoutMs) throw new Error(`No mail to ${to}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * The full app against the test database and Redis. Each app gets its own
 * Redis key prefix, so rate-limit counters never leak between tests.
 * Password hashing is made cheap here only to keep the tests fast.
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<{
  app: NestExpressApplication;
  config: AppConfig;
  mailer: FakeMailer;
}> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379',
    REDIS_KEY_PREFIX: `test:${randomUUID()}:`,
    AUTH_ARGON2_MEMORY_KIB: '1024',
    AUTH_ARGON2_ITERATIONS: '1',
    RATE_LIMIT_AUTH_MAX: '1000',
    ...env,
  });
  const mailer = new FakeMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, config, mailer };
}

export const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;
