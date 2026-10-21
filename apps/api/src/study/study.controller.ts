import { Body, Controller, Delete, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import { ApiErrors } from '../openapi/api-errors.decorator';
import { ref } from '../openapi/contract-schemas';
import { type Study, studyJoinSchema } from './study.schemas';
import { StudyService } from './study.service';

const AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'] as const;

/** CONTRACT 4.6: the user study (spec 9, FE-10, D-027). */
@ApiTags('study')
@Controller('study')
export class StudyController {
  constructor(private readonly study: StudyService) {}

  @Get()
  @ApiResponse({
    status: 200,
    schema: ref('Study'),
    description: 'Whether the reader can join, or their held-out books with the predictions',
  })
  @ApiErrors(...AUTH_ERRORS)
  get(@CurrentUser() user: AuthUser): Promise<Study> {
    return this.study.get(user.id);
  }

  @Post()
  @ApiBody({ schema: ref('StudyJoin') })
  @ApiResponse({
    status: 201,
    schema: ref('Study'),
    description: 'Joined; the predictions are made',
  })
  @ApiResponse({ status: 200, schema: ref('Study'), description: 'Already joined' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'CONFLICT')
  async join(
    @CurrentUser() user: AuthUser,
    @Body(new ZodBodyPipe(studyJoinSchema)) _body: { consent: true },
    @Res({ passthrough: true }) res: Response,
  ): Promise<Study> {
    const { study, created } = await this.study.join(user.id);
    res.status(created ? 201 : 200);
    return study;
  }

  @Delete()
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Left the study; its predictions are deleted' })
  @ApiErrors(...AUTH_ERRORS)
  async leave(@CurrentUser() user: AuthUser): Promise<void> {
    await this.study.leave(user.id);
  }
}
