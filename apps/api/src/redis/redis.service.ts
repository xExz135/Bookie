import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';

/** How often a "Redis is down" warning may be logged. */
const WARN_INTERVAL_MS = 60_000;

/**
 * Shared Redis connection. It connects on first use, so the app can start
 * (and generate OpenAPI) without Redis. Commands fail fast while Redis is
 * down, so callers can fall back instead of hanging (spec 10: if the cache
 * layer is down, continue).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  private client: Redis | null = null;
  private connecting: Promise<void> | null = null;
  private lastWarning = 0;
  readonly prefix: string;

  constructor(@InjectConfig() private readonly config: AppConfig) {
    this.prefix = config.REDIS_KEY_PREFIX;
  }

  /** The connected client. Throws if Redis cannot be reached right now. */
  async connection(): Promise<Redis> {
    if (!this.client) {
      this.client = new Redis(this.config.REDIS_URL, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        // Keep trying in the background; commands fail fast meanwhile.
        retryStrategy: (times) => Math.min(times * 500, 5000),
      });
      this.client.on('error', (error: Error) => this.warn(`Redis error: ${error.message}`));
    }
    const client = this.client;
    if (client.status === 'wait') {
      this.connecting ??= client.connect().finally(() => {
        this.connecting = null;
      });
    }
    if (this.connecting) await this.connecting;
    if (client.status !== 'ready') throw new Error(`Redis is not ready (${client.status})`);
    return client;
  }

  /** Logs at most once a minute, so an outage does not flood the logs. */
  warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarning < WARN_INTERVAL_MS) return;
    this.lastWarning = now;
    this.logger.warn(message);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      if (client.status === 'ready') await client.quit();
      else client.disconnect();
    } catch {
      client.disconnect();
    }
  }
}
