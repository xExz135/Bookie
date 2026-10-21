import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import { ApiErrors } from '../openapi/api-errors.decorator';
import { ref } from '../openapi/contract-schemas';
import { CompareService } from './compare.service';
import { FeedbackService } from './feedback.service';
import { MyDataService } from './my-data.service';
import {
  type Comparison,
  deleteMyDataSchema,
  type FeedbackRequest,
  feedbackRequestSchema,
  type FeedbackSaved,
  type ReadingList,
  readingListAddSchema,
  type ReadingListEntry,
} from './reader-data.schemas';
import { ReadingListService } from './reading-list.service';

const AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'] as const;

/** CONTRACT 4.5: feedback on one section of the reader's own analysis (FB-1, FB-2). */
@ApiTags('feedback')
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Put()
  @ApiBody({ schema: ref('FeedbackRequest') })
  @ApiResponse({ status: 200, schema: ref('FeedbackSaved'), description: 'Saved or replaced' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND', 'CONFLICT')
  save(
    @CurrentUser() user: AuthUser,
    @Body(new ZodBodyPipe(feedbackRequestSchema)) body: FeedbackRequest,
  ): Promise<FeedbackSaved> {
    return this.feedback.save(user.id, body);
  }
}

/** CONTRACT 4.5: the reader's reading list (LIST-1, LIST-2). */
@ApiTags('reading-list')
@Controller('reading-list')
export class ReadingListController {
  constructor(private readonly list: ReadingListService) {}

  @Get()
  @ApiResponse({
    status: 200,
    schema: ref('ReadingList'),
    description: 'Ranked by stored match where confident; the rest labeled, newest first',
  })
  @ApiErrors(...AUTH_ERRORS)
  get(@CurrentUser() user: AuthUser): Promise<ReadingList> {
    return this.list.list(user.id);
  }

  @Post()
  @ApiBody({ schema: ref('ReadingListAdd') })
  @ApiResponse({ status: 201, schema: ref('ReadingListEntry'), description: 'Added' })
  @ApiResponse({ status: 200, schema: ref('ReadingListEntry'), description: 'Already on the list' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND')
  async add(
    @CurrentUser() user: AuthUser,
    @Body(new ZodBodyPipe(readingListAddSchema)) body: { editionId: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadingListEntry> {
    const { entry, created } = await this.list.add(user.id, body.editionId);
    res.status(created ? 201 : 200);
    return entry;
  }

  @Delete(':editionId')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Removed, or was not on the list' })
  @ApiErrors(...AUTH_ERRORS, 'NOT_FOUND')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('editionId') editionId: string,
  ): Promise<void> {
    await this.list.remove(user.id, editionId);
  }
}

/** CONTRACT 4.5: two of the reader's analyses side by side. */
@ApiTags('compare')
@Controller('compare')
export class CompareController {
  constructor(private readonly compareService: CompareService) {}

  @Get()
  @ApiQuery({ name: 'a', required: true, description: 'Analysis id' })
  @ApiQuery({ name: 'b', required: true, description: 'Another analysis id' })
  @ApiResponse({ status: 200, schema: ref('Comparison') })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND')
  compare(
    @CurrentUser() user: AuthUser,
    @Query('a') a: unknown,
    @Query('b') b: unknown,
  ): Promise<Comparison> {
    return this.compareService.compare(user.id, a, b);
  }
}

/** CONTRACT 4.5: delete my data (SEC-3, D-022). The account stays. */
@ApiTags('account')
@Controller('me/data')
export class MyDataController {
  constructor(private readonly myData: MyDataService) {}

  @Delete()
  @HttpCode(204)
  @ApiBody({ schema: ref('DeleteMyDataRequest') })
  @ApiResponse({ status: 204, description: 'Deleted; onboarding starts again' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'RATE_LIMITED')
  async delete(
    @CurrentUser() user: AuthUser,
    @Body(new ZodBodyPipe(deleteMyDataSchema)) body: { password: string },
  ): Promise<void> {
    await this.myData.deleteAll(user.id, body.password);
  }
}
