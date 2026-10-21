import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthThrottle } from './auth-throttle';
import { AuthController, MeController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password-hasher';

@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    AuthThrottle,
    PasswordHasher,
    // Every route needs a valid access token unless marked @Public() (SEC-2).
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
