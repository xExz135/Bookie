import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { AppConfig } from '../config/app-config';
import { InjectConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-reader scan quota (spec 6, spec 12): SCAN_DAILY_QUOTA scans in any 24
 * hours. Kept in the database (scan_usages holds only the reader and the
 * time), so it is exact and survives restarts. A per-reader lock stops two
 * parallel scans from both taking the last slot.
 */
@Injectable()
export class ScanQuota {
  constructor(
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  /** Takes one scan from the quota, or throws SCAN_QUOTA_EXCEEDED. Returns the usage id. */
  async reserve(userId: string): Promise<bigint> {
    return this.prisma.$transaction(async (tx) => {
      // The lock function returns void, which Prisma cannot read, so select a constant.
      await tx.$queryRawUnsafe(
        `SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('scan:' || $1))`,
        userId,
      );
      const since = new Date(Date.now() - WINDOW_MS);
      const used = await tx.scanUsage.count({ where: { userId, scannedAt: { gt: since } } });
      if (used >= this.config.SCAN_DAILY_QUOTA) {
        const oldest = await tx.scanUsage.findFirst({
          where: { userId, scannedAt: { gt: since } },
          orderBy: { scannedAt: 'asc' },
          select: { scannedAt: true },
        });
        const freesAt = (oldest?.scannedAt.getTime() ?? Date.now()) + WINDOW_MS;
        throw new ApiError('SCAN_QUOTA_EXCEEDED', {
          retryAfterSeconds: Math.max(1, Math.ceil((freesAt - Date.now()) / 1000)),
        });
      }
      const usage = await tx.scanUsage.create({ data: { userId }, select: { id: true } });
      return usage.id;
    });
  }

  /** Gives a scan back when identification failed on our side (service down, quota). */
  async release(usageId: bigint): Promise<void> {
    await this.prisma.scanUsage.deleteMany({ where: { id: usageId } });
  }
}
