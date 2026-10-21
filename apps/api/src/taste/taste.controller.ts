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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { ApiError } from '../common/api-error';
import { parseBody, ZodBodyPipe } from '../common/zod-body.pipe';
import { ApiErrors } from '../openapi/api-errors.decorator';
import { ref } from '../openapi/contract-schemas';
import { RatingImportService } from './rating-import.service';
import {
  type CatalogSearchResult,
  catalogQuerySchema,
  importConfirmRequestSchema,
  type ProfileSaved,
  type QuestionnaireOptions,
  type QuestionnaireRequest,
  questionnaireRequestSchema,
  type RatingImportView,
  type RatingList,
  ratingListQuerySchema,
  ratingRequestSchema,
  type TasteProfileView,
} from './taste.schemas';
import { TasteService } from './taste.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'] as const;

/** CONTRACT 4.2: taste capture. Every route is the signed-in reader's own data (SEC-1). */
@ApiTags('taste')
@Controller()
export class TasteController {
  constructor(
    private readonly taste: TasteService,
    private readonly imports: RatingImportService,
  ) {}

  @Get('taste-profile')
  @ApiResponse({ status: 200, schema: ref('TasteProfile') })
  @ApiErrors(...AUTH_ERRORS)
  profile(@CurrentUser() user: AuthUser): Promise<TasteProfileView> {
    return this.taste.profile(user.id);
  }

  @Get('ratings')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200, default 50' })
  @ApiResponse({ status: 200, schema: ref('RatingList'), description: 'Current version, by title' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS)
  ratings(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<RatingList> {
    const { cursor, limit } = parseBody(ratingListQuerySchema, query);
    return this.taste.ratings(user.id, cursor, limit);
  }

  @Put('ratings/:editionId')
  @ApiBody({ schema: ref('RatingRequest') })
  @ApiResponse({ status: 200, schema: ref('ProfileSaved'), description: 'A new profile version' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND', 'RATE_LIMITED')
  rate(
    @CurrentUser() user: AuthUser,
    @Param('editionId') editionId: string,
    @Body(new ZodBodyPipe(ratingRequestSchema)) body: { rating: number },
  ): Promise<ProfileSaved> {
    return this.taste.setRating(user.id, editionId, body.rating);
  }

  @Delete('ratings/:editionId')
  @ApiResponse({ status: 200, schema: ref('ProfileSaved'), description: 'A new profile version' })
  @ApiErrors(...AUTH_ERRORS, 'NOT_FOUND', 'RATE_LIMITED')
  unrate(
    @CurrentUser() user: AuthUser,
    @Param('editionId') editionId: string,
  ): Promise<ProfileSaved> {
    return this.taste.removeRating(user.id, editionId);
  }

  @Get('catalog/search')
  @ApiQuery({ name: 'q', required: false, description: 'Leave out for the most-rated books' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50' })
  @ApiResponse({ status: 200, schema: ref('CatalogSearchResult') })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'RATE_LIMITED')
  catalogSearch(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<CatalogSearchResult> {
    const { q, limit } = parseBody(catalogQuerySchema, query);
    return this.taste.catalogSearch(user.id, q, limit);
  }

  @Get('questionnaire/options')
  @ApiResponse({ status: 200, schema: ref('QuestionnaireOptions') })
  @ApiErrors(...AUTH_ERRORS)
  questionnaireOptions(): Promise<QuestionnaireOptions> {
    return this.taste.questionnaireOptions();
  }

  @Put('questionnaire')
  @ApiBody({ schema: ref('QuestionnaireRequest') })
  @ApiResponse({ status: 200, schema: ref('ProfileSaved'), description: 'A new profile version' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'RATE_LIMITED')
  saveQuestionnaire(
    @CurrentUser() user: AuthUser,
    @Body(new ZodBodyPipe(questionnaireRequestSchema)) body: QuestionnaireRequest,
  ): Promise<ProfileSaved> {
    return this.taste.saveQuestionnaire(user.id, body);
  }

  @Post('onboarding/skip')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Onboarding is not shown again (D-002)' })
  @ApiErrors(...AUTH_ERRORS, 'CONFLICT')
  skipOnboarding(@CurrentUser() user: AuthUser): Promise<void> {
    return this.taste.skipOnboarding(user.id);
  }

  @Post('ratings/import')
  @HttpCode(202)
  // Memory storage only: the file is parsed and dropped (spec 12).
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Goodreads or StoryGraph export (CSV)',
        },
      },
    },
  })
  @ApiResponse({
    status: 202,
    schema: ref('ImportStarted'),
    description: 'Poll GET /ratings/import/{importId}',
  })
  @ApiErrors(
    'VALIDATION_FAILED',
    ...AUTH_ERRORS,
    'UPLOAD_TOO_LARGE',
    'UNSUPPORTED_TYPE',
    'RATE_LIMITED',
  )
  async startImport(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ): Promise<{ importId: string }> {
    return { importId: await this.imports.upload(user.id, file) };
  }

  @Get('ratings/import/:importId')
  @ApiResponse({ status: 200, schema: ref('RatingImport') })
  @ApiErrors(...AUTH_ERRORS, 'NOT_FOUND')
  getImport(
    @CurrentUser() user: AuthUser,
    @Param('importId') importId: string,
  ): Promise<RatingImportView> {
    if (!UUID.test(importId)) throw new ApiError('NOT_FOUND');
    return this.imports.get(user.id, importId);
  }

  @Post('ratings/import/:importId/confirm')
  @HttpCode(200)
  @ApiBody({ schema: ref('ImportConfirmRequest') })
  @ApiResponse({ status: 200, schema: ref('ProfileSaved'), description: 'A new profile version' })
  @ApiErrors('VALIDATION_FAILED', ...AUTH_ERRORS, 'NOT_FOUND', 'CONFLICT')
  async confirmImport(
    @CurrentUser() user: AuthUser,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ): Promise<ProfileSaved> {
    if (!UUID.test(importId)) throw new ApiError('NOT_FOUND');
    const { resolutions } = parseBody(importConfirmRequestSchema, body);
    const version = await this.imports.confirm(user.id, importId, resolutions);
    return { tasteProfileVersion: version.versionNo, ratedCount: version.ratedCount };
  }
}
