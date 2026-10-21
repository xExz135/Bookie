import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

export interface RateLimitRule {
  /** Requests allowed in one window. */
  max: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

/** Counts a hit and returns the count and the milliseconds left in the window. */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * Fixed-window request counter, shared by sign-in throttling (D-001), scans
 * and analyses. Counts live in Redis so every API instance sees them. If
 * Redis is down, counting continues in this process's memory instead of
 * letting every request through.
 */
@Injectable()
export class RateLimiter {
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly redis: RedisService) {}

  /**
   * Records one request for `key` and says whether it is within the rule.
   * Keys must not contain personal data in clear text (hash emails first).
   */
  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;
    let count: number;
    let ttlMs: number;
    try {
      const client = await this.redis.connection();
      const reply = (await client.eval(
        HIT_SCRIPT,
        1,
        `${this.redis.prefix}rl:${key}`,
        String(windowMs),
      )) as [number, number];
      [count, ttlMs] = reply;
    } catch (error) {
      this.redis.warn(`Rate limiting falls back to process memory: ${(error as Error).message}`);
      ({ count, ttlMs } = this.hitInMemory(key, windowMs));
    }
    return {
      allowed: count <= rule.max,
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }

  private hitInMemory(key: string, windowMs: number): { count: number; ttlMs: number } {
    const now = Date.now();
    if (this.memory.size > 10_000) {
      for (const [k, entry] of this.memory) if (entry.resetAt <= now) this.memory.delete(k);
    }
    let entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.memory.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, ttlMs: entry.resetAt - now };
  }
}
