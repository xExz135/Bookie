import { type Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';

/** Algorithm.Argon2id. The package exports a const enum, so its value is spelled out. */
const ARGON2ID = 2 as Algorithm;

/** argon2id password hashing (D-001). Plain passwords are never stored or logged. */
@Injectable()
export class PasswordHasher {
  private dummy: Promise<string> | null = null;

  constructor(@InjectConfig() private readonly config: AppConfig) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      algorithm: ARGON2ID,
      memoryCost: this.config.AUTH_ARGON2_MEMORY_KIB,
      timeCost: this.config.AUTH_ARGON2_ITERATIONS,
      parallelism: this.config.AUTH_ARGON2_PARALLELISM,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real check when the email is unknown, so
   * response time does not reveal which emails have accounts.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummy ??= this.hash('not-a-real-password-for-timing-only');
    await this.verify(await this.dummy, password);
    return false;
  }
}
