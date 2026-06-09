import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import type { JwtPayload } from '@org/types';
import { Public } from '@org/decorators';

@Controller()
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  /**
   * Catch-all proxy. Marked @Public() so the JWT guard doesn't block the request —
   * JWT validation + user injection is handled by JwtMiddleware (soft-auth), which
   * sets req.user when a valid token is present without throwing on missing tokens.
   * Downstream services enforce their own auth on protected endpoints.
   */
  @All('*')
  @Public()
  async handleAll(@Req() req: Request & { user?: JwtPayload }, @Res() res: Response) {
    return this.proxyService.forward(req, res, req.user);
  }
}
