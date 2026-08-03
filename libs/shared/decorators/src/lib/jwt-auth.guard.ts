import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from '@org/types';
import { Role } from '@org/types';
import { IS_PUBLIC_KEY, KYC_TIER_KEY, ROLES_KEY } from './decorators.js';

/**
 * Populates `request.user` for downstream services so `@CurrentUser()` resolves,
 * and enforces `@Roles()` / `@RequireKyc()`.
 *
 * The RS256 token is verified locally against JWT_PUBLIC_KEY rather than trusting
 * the gateway's forwarded x-user-* headers — a service reached directly (bypassing
 * the gateway) stays protected. Routes marked `@Public()` skip verification, which
 * is how service-to-service `internal/*` endpoints keep using their x-internal-key
 * check instead.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwtService: JwtService;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    const publicKey = (config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(
      /\\n/g,
      '\n',
    );
    this.jwtService = new JwtService({
      publicKey,
      verifyOptions: { algorithms: ['RS256'] },
    });
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(authHeader.slice(7));
    } catch {
      throw new UnauthorizedException();
    }

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles?.length && !requiredRoles.includes(payload.role)) {
      throw new ForbiddenException('Insufficient role');
    }

    const requiredKycTier = this.reflector.getAllAndOverride<number>(
      KYC_TIER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredKycTier != null && (payload.kycTier ?? 0) < requiredKycTier) {
      throw new ForbiddenException(`KYC tier ${requiredKycTier} required`);
    }

    request.user = payload;
    return true;
  }
}
