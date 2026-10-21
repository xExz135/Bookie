import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { parseBody } from '../common/zod-body.pipe';
import { ApiErrors } from '../openapi/api-errors.decorator';
import { ref } from '../openapi/contract-schemas';
import { BookSearchService } from './book-search.service';
import { type BookSearchResult, type ScanResult, searchQuerySchema } from './discovery.schemas';
import { ScanService, type UploadedImage } from './scan.service';

/** CONTRACT 4.3: typed search and cover scan. Both need a signed-in reader (SEC-2). */
@ApiTags('discovery')
@Controller()
export class DiscoveryController {
  constructor(
    private readonly search: BookSearchService,
    private readonly scanner: ScanService,
  ) {}

  @Get('books/search')
  @ApiQuery({ name: 'q', description: 'Title, author, both, or an ISBN', required: true })
  @ApiResponse({
    status: 200,
    schema: ref('BookSearchResult'),
    description: 'At most SEARCH_MAX_CANDIDATES books, one edition each. Never auto-selected.',
  })
  @ApiErrors('VALIDATION_FAILED', 'UNAUTHENTICATED', 'TOKEN_EXPIRED', 'RATE_LIMITED')
  searchBooks(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<BookSearchResult> {
    const { q } = parseBody(searchQuerySchema, query);
    return this.search.search(user.id, q);
  }

  @Post('scan')
  @HttpCode(200)
  // Memory storage only: no `dest`, so the file never touches the disk (DISC-3).
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: {
        image: {
          type: 'string',
          format: 'binary',
          description: 'Cover photo, JPEG or PNG, resized by the client (default 1024 px)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    schema: ref('ScanResult'),
    description: '"uncertain" always goes to the confirmation screen (DISC-2)',
  })
  @ApiErrors(
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'UPLOAD_TOO_LARGE',
    'UNSUPPORTED_TYPE',
    'NOT_A_BOOK',
    'UNREADABLE_IMAGE',
    'SCAN_QUOTA_EXCEEDED',
    'IDENTIFICATION_UNAVAILABLE',
  )
  scan(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<ScanResult> {
    return this.scanner.scan(user.id, file);
  }
}
