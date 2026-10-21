import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/auth.guard';

/**
 * Liveness check for Docker and CI, at /health (outside /api/v1).
 * Public by design and returns no data (operational exception to SEC-2, see CONTRACT 2).
 */
@Public()
@ApiExcludeController()
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
