import { Injectable, Logger } from '@nestjs/common';
import { PasswordHasher } from '../auth/password-hasher';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import { RateLimiter } from '../redis/rate-limiter';

/**
 * Delete my data (spec 12, SEC-3, D-022): removes everything the reader
 * created (taste-profile versions with their ratings and answers, rating
 * imports, analyses with their personal matches and steps, feedback, the
 * reading list and the user-study participation) and starts onboarding again. The account itself stays, as do
 * the scan and refresh counters (documented exceptions in D-022), so limits
 * cannot be reset by deleting data. Shared catalog rows and public review
 * summaries belong to no reader and stay.
 */
@Injectable()
export class MyDataService {
  private readonly logger = new Logger('MyData');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly limiter: RateLimiter,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async deleteAll(userId: string, password: string): Promise<void> {
    const limit = await this.limiter.hit(`delete-data:user:${userId}`, {
      max: this.config.RATE_LIMIT_DELETE_DATA_PER_HOUR,
      windowSeconds: 3600,
    });
    if (!limit.allowed) {
      throw new ApiError('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new ApiError('VALIDATION_FAILED', {
        fields: { password: 'That password is not correct.' },
      });
    }

    // Children first; each table's own cascades remove the rest (steps,
    // ratings, preferences, import rows, explanation rows).
    const counts = await this.prisma.$transaction([
      this.prisma.feedback.deleteMany({ where: { userId } }),
      this.prisma.studyParticipant.deleteMany({ where: { userId } }),
      this.prisma.readingListItem.deleteMany({ where: { userId } }),
      this.prisma.personalAnalysis.deleteMany({ where: { userId } }),
      this.prisma.analysis.deleteMany({ where: { userId } }),
      this.prisma.ratingImport.deleteMany({ where: { userId } }),
      this.prisma.tasteProfileVersion.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { onboardingState: 'pending' },
        select: { id: true },
      }),
    ]);
    // Counts only: no titles, ratings or other personal data in the log.
    const [feedback, study, readingList, personal, analyses, imports, versions] = counts
      .slice(0, 7)
      .map((c) => (c as { count: number }).count);
    this.logger.log(
      `Deleted reader data: ${versions} profile versions, ${imports} imports, ${analyses} analyses, ${personal} personal matches, ${feedback} feedback, ${readingList} reading-list items, ${study} study participations`,
    );
  }
}
