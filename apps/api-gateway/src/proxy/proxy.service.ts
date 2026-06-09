import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import type { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';
import type { AxiosRequestConfig } from 'axios';
import type { JwtPayload } from '@org/types';

interface ServiceRoute {
  prefix: string;
  target: string;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly routes: ServiceRoute[];
  private readonly internalApiKey: string;

  constructor(
    config: ConfigService,
    private readonly http: HttpService,
  ) {
    const base = (envKey: string, defaultPort: number) =>
      config.get(envKey, `http://localhost:${defaultPort}`);

    this.routes = [
      { prefix: '/api/auth', target: base('AUTH_SERVICE_URL', 3001) },
      { prefix: '/api/users', target: base('USER_SERVICE_URL', 3002) },
      { prefix: '/api/markets', target: base('MARKET_SERVICE_URL', 3003) },
      { prefix: '/api/trades', target: base('TRADING_SERVICE_URL', 3004) },
      { prefix: '/api/wallet', target: base('WALLET_SERVICE_URL', 3005) },
      { prefix: '/api/payments', target: base('PAYMENT_SERVICE_URL', 3006) },
      { prefix: '/api/notifications', target: base('NOTIFICATION_SERVICE_URL', 3007) },
      { prefix: '/api/callbacks', target: base('PAYMENT_SERVICE_URL', 3006) },
    ];

    this.internalApiKey = config.get('INTERNAL_API_KEY', 'changeme');
  }

  private resolve(path: string): ServiceRoute | undefined {
    return this.routes.find((r) => path.startsWith(r.prefix));
  }

  async forward(req: Request, res: Response, user?: JwtPayload): Promise<void> {
    const route = this.resolve(req.path);

    if (!route) {
      res.status(404).json({ statusCode: 404, message: 'Route not found' });
      return;
    }

    const query = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const targetUrl = `${route.target}${req.path}${query}`;

    // Build forwarded headers — inject authenticated user context
    const forwardedHeaders: Record<string, string | undefined> = {
      'content-type': req.headers['content-type'],
      authorization: req.headers['authorization'],
      'x-forwarded-for': req.ip,
      'x-internal-key': this.internalApiKey,
    };

    if (user) {
      forwardedHeaders['x-user-id'] = user.sub;
      forwardedHeaders['x-user-role'] = user.role;
      forwardedHeaders['x-user-kyc-tier'] = String(user.kycTier);
    }

    const config: AxiosRequestConfig = {
      method: req.method as AxiosRequestConfig['method'],
      url: targetUrl,
      headers: forwardedHeaders,
      data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      validateStatus: () => true,
      responseType: 'arraybuffer',
    };

    try {
      const response = await firstValueFrom(this.http.request(config));

      res.status(response.status);

      const contentType = response.headers['content-type'] as string | undefined;
      if (contentType) res.setHeader('content-type', contentType);

      res.send(response.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Proxy error → ${targetUrl}: ${msg}`);
      res.status(502).json({ statusCode: 502, message: 'Bad gateway' });
    }
  }
}
