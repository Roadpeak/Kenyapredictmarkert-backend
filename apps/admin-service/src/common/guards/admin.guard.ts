import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from '@org/types';
import { Role } from '@org/types';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly jwtService: JwtService;

  constructor(config: ConfigService) {
    const publicKey = (config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(/\\n/g, '\n');
    this.jwtService = new JwtService({
      publicKey,
      verifyOptions: { algorithms: ['RS256'] },
    });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    try {
      const token = authHeader.slice(7);
      const payload = this.jwtService.verify<JwtPayload>(token);

      if (payload.role !== Role.ADMIN && payload.role !== Role.SUPER_ADMIN) {
        throw new ForbiddenException('Admin access required');
      }

      request.user = payload;
      return true;
    } catch (err: unknown) {
      if (err instanceof ForbiddenException) throw err;
      throw new UnauthorizedException();
    }
  }
}
