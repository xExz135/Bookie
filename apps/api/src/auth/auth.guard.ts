import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  applyDecorators,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { type AuthUser, AuthService } from './auth.service';

const IS_PUBLIC = 'bookie:isPublic';

/**
 * Marks a route as reachable without signing in. SEC-2 allows this only for
 * /auth/* and /health; a test fails if it appears anywhere else.
 */
export const Public = (): ClassDecorator & MethodDecorator =>
  ((target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      // On a route: also tell OpenAPI that no access token is needed.
      applyDecorators(SetMetadata(IS_PUBLIC, true), ApiOperation({ security: [] }))(
        target,
        key!,
        descriptor,
      );
      return descriptor;
    }
    SetMetadata(IS_PUBLIC, true)(target as never);
    return undefined;
  }) as ClassDecorator & MethodDecorator;

type AuthedRequest = Request & { user?: AuthUser };

/** The signed-in reader. Use it to scope every query to their own data (SEC-1). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new ApiError('UNAUTHENTICATED');
  return user;
});

const BEARER = /^Bearer ([A-Za-z0-9_\-.]+)$/;

/** Applied to every route (SEC-2): no valid access token, no access. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match) throw new ApiError('UNAUTHENTICATED');
    request.user = await this.auth.authenticate(match[1]!);
    return true;
  }
}
