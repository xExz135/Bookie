import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { RateLimiter } from '../redis/rate-limiter';
import { hashForKey } from './tokens';

export type ThrottledAction = 'register' | 'login' | 'forgot-password';

/**
 * Throttling per IP and per email on register, login and forgot-password
 * (D-001). It slows guessing down; it is not an account lockout.
 */
@Injectable()
export class AuthThrottle {
  constructor(
    private readonly limiter: RateLimiter,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async check(action: ThrottledAction, ip: string | undefined, email: string): Promise<void> {
    const rule = {
      max: this.config.RATE_LIMIT_AUTH_MAX,
      windowSeconds: this.config.RATE_LIMIT_AUTH_WINDOW_SECONDS,
    };
    // Both counters move on every request, so neither can be used to probe the other.
    const results = await Promise.all([
      this.limiter.hit(`auth:${action}:ip:${ip ?? 'unknown'}`, rule),
      this.limiter.hit(`auth:${action}:email:${hashForKey(email)}`, rule),
    ]);
    const blocked = results.filter((r) => !r.allowed);
    if (blocked.length > 0) {
      throw new ApiError('RATE_LIMITED', {
        retryAfterSeconds: Math.max(...blocked.map((r) => r.retryAfterSeconds)),
      });
    }
  }
}
