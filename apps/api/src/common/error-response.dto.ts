import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ERROR_CODES, type ErrorCode } from '../contract/error-codes';

/** OpenAPI description of the error body (CONTRACT section 2). */
export class ErrorResponseDto {
  @ApiProperty({ enum: Object.keys(ERROR_CODES), enumName: 'ErrorCode' })
  code!: ErrorCode;

  @ApiProperty({ description: 'Safe default text. The frontend maps `code` to its own wording.' })
  message!: string;

  @ApiProperty()
  retryable!: boolean;

  @ApiPropertyOptional({ type: Number })
  retryAfterSeconds?: number;

  @ApiPropertyOptional({
    description: 'Present only for VALIDATION_FAILED: field name to message.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  fields?: Record<string, string>;
}
