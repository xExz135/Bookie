import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { ApiError } from '../src/common/api-error';
import { loadConfig } from '../src/config/app-config';
import { buildOpenApiDocument } from '../src/openapi/document';

/** Routes that only exist in this test, to exercise the error filter. */
@Controller('test-errors')
class ThrowingController {
  @Get('api-error')
  apiError(): never {
    throw new ApiError('VALIDATION_FAILED', { fields: { email: 'Enter a valid email.' } });
  }

  @Get('rate-limited')
  rateLimited(): never {
    throw new ApiError('RATE_LIMITED', { retryAfterSeconds: 60 });
  }

  @Get('crash')
  crash(): never {
    throw new Error('database password is hunter2');
  }
}

@Module({ controllers: [ThrowingController] })
class ThrowingModule {}

describe('API foundations (BE-1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(loadConfig({ NODE_ENV: 'test' }), { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers ok outside the API prefix', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('an unknown route returns the contract error shape', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Not found.', retryable: false });
  });

  it('does not send the X-Powered-By header', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('builds an OpenAPI document with the error schema and shared enums', () => {
    const doc = buildOpenApiDocument(app);
    const schemas = doc.components?.schemas ?? {};
    expect(schemas).toHaveProperty('ErrorResponseDto');
    expect(schemas).toHaveProperty('StepName');
    expect(schemas).toHaveProperty('PersonalMatchStatus');
    expect(JSON.stringify(doc)).not.toContain('/health');
  });
});

describe('error filter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ThrowingModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns VALIDATION_FAILED with fields', async () => {
    const res = await request(app.getHttpServer()).get('/test-errors/api-error').expect(400);
    expect(res.body).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Some fields are invalid.',
      retryable: false,
      fields: { email: 'Enter a valid email.' },
    });
  });

  it('returns retryAfterSeconds and the Retry-After header', async () => {
    const res = await request(app.getHttpServer()).get('/test-errors/rate-limited').expect(429);
    expect(res.body).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(res.headers['retry-after']).toBe('60');
  });

  it('hides internal details of an unexpected error', async () => {
    const res = await request(app.getHttpServer()).get('/test-errors/crash').expect(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side.',
      retryable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });
});
