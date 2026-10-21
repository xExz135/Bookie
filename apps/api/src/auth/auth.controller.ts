import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { parseBody } from '../common/zod-body.pipe';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { ApiErrors } from '../openapi/api-errors.decorator';
import { ref } from '../openapi/contract-schemas';
import { AuthThrottle } from './auth-throttle';
import { CurrentUser, Public } from './auth.guard';
import {
  type AccessTokenView,
  type AuthRequests,
  type AuthSessionView,
  type UserView,
  authRequestSchemas,
} from './auth.schemas';
import { type AuthUser, AuthService } from './auth.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

/** CONTRACT 4.1. Every /auth/* endpoint is public (D-001, SEC-2). */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly schemas: AuthRequests;

  constructor(
    private readonly auth: AuthService,
    private readonly throttle: AuthThrottle,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    this.schemas = authRequestSchemas(config);
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  @ApiBody({ schema: ref('RegisterRequest') })
  @ApiResponse({ status: 201, schema: ref('AuthSession'), description: 'Signed in right away' })
  @ApiErrors('VALIDATION_FAILED', 'EMAIL_IN_USE', 'RATE_LIMITED')
  async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionView> {
    const input = parseBody(this.schemas.register, body);
    await this.throttle.check('register', req.ip, input.email);
    const { session, refreshToken } = await this.auth.register(input);
    setRefreshCookie(res, refreshToken, this.config);
    return session;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: ref('LoginRequest') })
  @ApiResponse({ status: 200, schema: ref('AuthSession') })
  @ApiErrors('VALIDATION_FAILED', 'INVALID_CREDENTIALS', 'RATE_LIMITED')
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionView> {
    const input = parseBody(this.schemas.login, body);
    await this.throttle.check('login', req.ip, input.email);
    const { session, refreshToken } = await this.auth.login(input);
    setRefreshCookie(res, refreshToken, this.config);
    return session;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiResponse({
    status: 200,
    schema: ref('AccessToken'),
    description: 'Also sets a new refresh cookie. The old refresh token stops working.',
  })
  @ApiErrors('UNAUTHENTICATED')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenView> {
    try {
      const { access, refreshToken } = await this.auth.refresh(readRefreshCookie(req));
      setRefreshCookie(res, refreshToken, this.config);
      return access;
    } catch (error) {
      clearRefreshCookie(res, this.config);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Signed out. Always succeeds.' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.config);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @ApiBody({ schema: ref('ForgotPasswordRequest') })
  @ApiResponse({ status: 202, description: 'Identical for known and unknown emails' })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  async forgotPassword(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = parseBody(this.schemas.forgotPassword, body);
    await this.throttle.check('forgot-password', req.ip, input.email);
    await this.auth.forgotPassword(input.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @ApiBody({ schema: ref('ResetPasswordRequest') })
  @ApiResponse({ status: 204, description: 'Password changed. Every session ends.' })
  @ApiErrors('VALIDATION_FAILED')
  async resetPassword(@Body() body: unknown): Promise<void> {
    await this.auth.resetPassword(parseBody(this.schemas.resetPassword, body));
  }
}

/** The signed-in reader's own account (SEC-1: only ever their own). */
@ApiTags('account')
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @ApiResponse({ status: 200, schema: ref('User') })
  @ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
  me(@CurrentUser() user: AuthUser): Promise<UserView> {
    return this.auth.me(user.id);
  }
}
