import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response, NextFunction } from 'express';
import type { JwtPayload } from '@org/types';

/**
 * Soft-auth middleware: decodes JWT if present, attaches payload to req.user.
 * Does NOT throw on missing/invalid token — downstream services enforce auth.
 */
@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly jwtService: JwtService;

  constructor(config: ConfigService) {
    const publicKey = (config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(/\\n/g, '\n');
    this.jwtService = new JwtService({
      publicKey,
      verifyOptions: { algorithms: ['RS256'] },
    });
  }

  use(req: Request & { user?: JwtPayload }, _res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        req.user = this.jwtService.verify<JwtPayload>(token);
      } catch {
        // Invalid token — leave req.user undefined; downstream will 401 if needed
      }
    }
    next();
  }
}
