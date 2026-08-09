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
      { prefix: '/api/feed', target: base('FEED_SERVICE_URL', 3008) },
      { prefix: '/api/callbacks', target: base('PAYMENT_SERVICE_URL', 3006) },
      // More specific admin prefixes must precede the catch-all '/api/admin',
      // which resolve() matches by first startsWith hit.
      { prefix: '/api/admin/payments', target: base('PAYMENT_SERVICE_URL', 3006) },
      { prefix: '/api/admin', target: base('ADMIN_SERVICE_URL', 3009) },
      { prefix: '/api/analytics', target: base('ANALYTICS_SERVICE_URL', 3010) },
      { prefix: '/api/comments', target: base('COMMENTS_SERVICE_URL', 3011) },
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

    // Nest's global body-parser only consumes application/json and
    // x-www-form-urlencoded bodies — a multipart/form-data request (file
    // uploads) is left untouched, with req.body empty and the raw stream
    // still readable. Forwarding req.body for those would silently drop
    // the file entirely, so multipart requests are piped through as a raw
    // stream instead of using the (empty) parsed body. The original
    // content-length is forwarded ONLY in this case, since it matches the
    // still-unconsumed stream; for the normal JSON path axios must compute
    // its own content-length from the re-serialized req.body, which can
    // differ in byte length from the original raw request (whitespace,
    // key order) — forwarding the original there caused a length mismatch
    // that made every plain JSON POST/PUT hang.
    const isMultipart = (req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    if (isMultipart) {
      forwardedHeaders['content-length'] = req.headers['content-length'];
    }

    const config: AxiosRequestConfig = {
      method: req.method as AxiosRequestConfig['method'],
      url: targetUrl,
      headers: forwardedHeaders,
      data: hasBody ? (isMultipart ? req : req.body) : undefined,
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
