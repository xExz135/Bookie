import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { InjectMailer, type Mailer } from '../mail/mailer';
import type {
  AccessTokenView,
  AuthSessionView,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  UserView,
} from './auth.schemas';
import { PasswordHasher } from './password-hasher';
import { hashToken, randomToken, signAccessToken, verifyAccessToken } from './tokens';

/** The signed-in reader, attached to the request by AuthGuard. */
export interface AuthUser {
  id: string;
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  onboardingState: UserView['onboardingState'];
  tokenVersion: number;
}

const DAY_MS = 86_400_000;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * Custom email and password authentication (D-001): argon2id passwords,
 * short-lived access tokens, refresh tokens stored as hashes and rotated on
 * every use, single-use reset links stored as hashes.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    @InjectConfig() private readonly config: AppConfig,
    @InjectMailer() private readonly mailer: Mailer,
  ) {}

  async register(
    input: RegisterRequest,
  ): Promise<{ session: AuthSessionView; refreshToken: string }> {
    const passwordHash = await this.passwords.hash(input.password);
    let user: UserRow;
    try {
      user = await this.prisma.user.create({
        data: { email: input.email, passwordHash, displayName: input.displayName },
      });
    } catch (error) {
      // Accepted trade-off of D-001: register reveals that an email is taken.
      if (isUniqueViolation(error)) throw new ApiError('EMAIL_IN_USE');
      throw error;
    }
    return this.startSession(user);
  }

  async login(input: LoginRequest): Promise<{ session: AuthSessionView; refreshToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const valid = user
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.verifyAgainstDummy(input.password);
    // Same answer for an unknown email and a wrong password.
    if (!user || !valid) throw new ApiError('INVALID_CREDENTIALS');
    return this.startSession(user);
  }

  /** Rotates the refresh token: the old one is revoked, a new one issued (D-001). */
  async refresh(
    refreshToken: string | undefined,
  ): Promise<{ access: AccessTokenView; refreshToken: string }> {
    if (!refreshToken) throw new ApiError('UNAUTHENTICATED');
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const [revoked] = await tx.refreshToken.updateManyAndReturn({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
        select: { userId: true },
      });
      if (!revoked) return null;
      const user = await tx.user.findUnique({
        where: { id: revoked.userId },
        select: { id: true, tokenVersion: true },
      });
      if (!user) return null;
      const next = randomToken();
      await tx.refreshToken.create({
        data: { userId: user.id, tokenHash: hashToken(next), expiresAt: this.refreshExpiry(now) },
      });
      return { user, next };
    });
    if (!result) throw new ApiError('UNAUTHENTICATED');
    return { access: this.accessToken(result.user), refreshToken: result.next };
  }

  /** Revokes the refresh token if it is valid. Always succeeds. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Sends a reset link if the email has an account. The caller answers the
   * same way either way, and the email is sent in the background so the
   * response time does not depend on it.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) return;
    const token = randomToken();
    const ttlMinutes = this.config.AUTH_RESET_TOKEN_TTL_MINUTES;
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
    });
    // The token sits in the URL fragment, which browsers never send to a server.
    const link = `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/reset-password#token=${token}`;
    void this.mailer
      .send({
        to: user.email,
        subject: 'Reset your Bookie password',
        text:
          `Hi ${user.displayName},\n\n` +
          `Someone asked to reset the password for your Bookie account. ` +
          `Open this link within ${ttlMinutes} minutes to choose a new password:\n\n${link}\n\n` +
          `If this was not you, ignore this email. Your password stays the same.\n`,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Reset email for user ${user.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /**
   * Sets a new password with a single-use link. Every refresh token is
   * revoked and the token version is raised, so all sessions end (D-001).
   */
  async resetPassword(input: ResetPasswordRequest): Promise<void> {
    const tokenHash = hashToken(input.token);
    const invalid = () =>
      new ApiError('VALIDATION_FAILED', {
        fields: { token: 'This reset link is invalid or has expired.' },
      });
    // Cheap check first, so an invalid link costs no password hashing.
    const found = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, expiresAt: true },
    });
    if (!found || found.usedAt || found.expiresAt <= new Date()) throw invalid();

    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      // Consumed atomically: two concurrent uses cannot both succeed.
      const [token] = await tx.passwordResetToken.updateManyAndReturn({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
        select: { userId: true },
      });
      if (!token) return false;
      await tx.user.update({
        where: { id: token.userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      // Other unused links for this account stop working too.
      await tx.passwordResetToken.updateMany({
        where: { userId: token.userId, usedAt: null },
        data: { usedAt: now },
      });
      return true;
    });
    if (!done) throw invalid();
  }

  /** Checks an access token and that its user still exists with the same token version. */
  async authenticate(accessToken: string): Promise<AuthUser> {
    const result = verifyAccessToken(accessToken, this.config.AUTH_TOKEN_SECRET);
    if (!result.ok) {
      throw new ApiError(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: result.claims.sub },
      select: { id: true, tokenVersion: true },
    });
    if (!user || user.tokenVersion !== result.claims.ver) throw new ApiError('UNAUTHENTICATED');
    return { id: user.id };
  }

  async me(userId: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError('UNAUTHENTICATED');
    return toUserView(user);
  }

  private async startSession(
    user: UserRow,
  ): Promise<{ session: AuthSessionView; refreshToken: string }> {
    const refreshToken = randomToken();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: this.refreshExpiry(new Date()),
      },
    });
    return {
      session: { ...this.accessToken(user), user: toUserView(user) },
      refreshToken,
    };
  }

  private accessToken(user: { id: string; tokenVersion: number }): AccessTokenView {
    const ttl = this.config.AUTH_ACCESS_TOKEN_TTL_SECONDS;
    return {
      accessToken: signAccessToken(user, this.config.AUTH_TOKEN_SECRET, ttl),
      expiresInSeconds: ttl,
    };
  }

  private refreshExpiry(from: Date): Date {
    return new Date(from.getTime() + this.config.AUTH_REFRESH_TOKEN_TTL_DAYS * DAY_MS);
  }
}

function toUserView(user: UserRow): UserView {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    onboardingState: user.onboardingState,
  };
}
