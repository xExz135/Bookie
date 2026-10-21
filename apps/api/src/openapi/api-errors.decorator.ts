import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/error-response.dto';
import { ERROR_CODES, type ErrorCode } from '../contract/error-codes';

/** Documents the contract error codes an endpoint can return, grouped by HTTP status. */
export function ApiErrors(...codes: ErrorCode[]): MethodDecorator & ClassDecorator {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(
    ...[...byStatus].map(([status, group]) =>
      ApiResponse({ status, description: group.join(', '), type: ErrorResponseDto }),
    ),
  );
}
