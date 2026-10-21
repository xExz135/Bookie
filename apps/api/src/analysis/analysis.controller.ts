import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import { ApiErrors } from '../openapi/api-errors.decorator';
import { ref } from '../openapi/contract-schemas';
import { type Analysis, retryAnalysisSchema, startAnalysisSchema } from './analysis.schemas';
import { AnalysisService } from './analysis.service';
import type { StepName } from './analysis.types';

const AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'] as const;

/** CONTRACT 4.4: analyses. Every route is the signed-in reader's own data (SEC-1). */
@ApiTags('analyses')
@Controller('analyses')
export class AnalysisController {
  constructor(private readonly analyses: AnalysisService) {}

  @Post()
  @ApiBody({ schema: ref('StartAnalysis') })
  @ApiResponse({ status: 201, schema: ref('Analysis'), description: 'Started' })
  @ApiResponse({
    status: 200,
    schema: ref('Analysis'),
    description: 'Joined the analysis already running for this edition and taste-profile version',
  })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND', 'RATE_LIMITED')
  async start(
    @CurrentUser() user: AuthUser,
    @Body(new ZodBodyPipe(startAnalysisSchema)) body: { editionId: string; refresh?: boolean },
    @Res({ passthrough: true }) res: Response,
  ): Promise<Analysis> {
    const { analysis, created } = await this.analyses.start(
      user.id,
      body.editionId,
      body.refresh ?? false,
    );
    res.status(created ? 201 : 200);
    return analysis;
  }

  @Get()
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 20' })
  @ApiResponse({ status: 200, schema: ref('AnalysisList'), description: 'History, newest first' })
  @ApiErrors(...AUTH_ERRORS)
  list(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.analyses.list(user.id, cursor, limit === undefined ? undefined : Number(limit));
  }

  @Get(':id')
  @ApiResponse({ status: 200, schema: ref('Analysis') })
  @ApiErrors(...AUTH_ERRORS, 'NOT_FOUND')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<Analysis> {
    return this.analyses.get(user.id, id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @ApiBody({ schema: ref('RetryAnalysis'), required: false })
  @ApiResponse({ status: 200, schema: ref('Analysis'), description: 'Running again' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED')
  retry(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodBodyPipe(retryAnalysisSchema)) body: { steps?: StepName[] },
  ): Promise<Analysis> {
    return this.analyses.retry(user.id, id, body?.steps);
  }

  @Post(':id/recalculate')
  @ApiResponse({
    status: 201,
    schema: ref('Analysis'),
    description: 'A new analysis for the current taste profile',
  })
  @ApiErrors(...AUTH_ERRORS, 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED')
  recalculate(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<Analysis> {
    return this.analyses.recalculate(user.id, id);
  }
}
