import { Global, Module } from '@nestjs/common';
import { RateLimiter } from './rate-limiter';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, RateLimiter],
  exports: [RedisService, RateLimiter],
})
export class RedisModule {}
