import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorCode } from '../contract/error-codes';
import { ApiError, errorBody } from './api-error';

/** Maps framework HTTP errors (unknown route, body too large, ...) to contract codes. */
const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'UPLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_TYPE',
  429: 'RATE_LIMITED',
};

/**
 * Every error leaves the API in the contract shape. Stack traces and internal
 * messages are logged on the server and never sent to the client (CONTRACT 6).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiError) {
      if (exception.options.retryAfterSeconds !== undefined) {
        response.setHeader('Retry-After', String(exception.options.retryAfterSeconds));
      }
      response.status(exception.status).json(exception.toBody());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status];
      if (code) {
        response.status(status).json(errorBody(code));
        return;
      }
    }

    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    response.status(500).json(errorBody('INTERNAL_ERROR'));
  }
}
