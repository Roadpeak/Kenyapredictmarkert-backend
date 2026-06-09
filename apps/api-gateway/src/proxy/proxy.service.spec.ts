import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { ProxyService } from './proxy.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockHttp = { request: jest.fn() };

const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? 'http://localhost:3000'),
};

function axiosRaw(status: number, data: Buffer | string = Buffer.from('{"ok":true}')): AxiosResponse {
  return {
    data: typeof data === 'string' ? Buffer.from(data) : data,
    status,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    config: { headers: new AxiosHeaders() },
  };
}

function makeReq(path: string, method = 'GET', body?: object, user?: object): any {
  return {
    path,
    method,
    url: path,
    headers: { 'content-type': 'application/json', authorization: 'Bearer some-token' },
    ip: '127.0.0.1',
    body: body ?? {},
    user,
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProxyService', () => {
  let service: ProxyService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProxyService,
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<ProxyService>(ProxyService);
  });

  // ── resolve ─────────────────────────────────────────────────────────────────

  describe('route resolution', () => {
    it('returns 404 when no route matches the path', async () => {
      const req = makeReq('/api/unknown-service/foo');
      const res = makeRes();

      await service.forward(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ── forward — success ───────────────────────────────────────────────────────

  describe('forward — success', () => {
    it('proxies GET request to correct service and sends response', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(200)));

      const req = makeReq('/api/markets');
      const res = makeRes();

      await service.forward(req, res);

      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('/api/markets'),
        }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalled();
    });

    it('proxies POST request with body', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(201)));

      const body = { marketId: 'm-1', outcome: 'YES', amountKes: 100 };
      const req = makeReq('/api/trades', 'POST', body);
      const res = makeRes();

      await service.forward(req, res);

      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', data: body }),
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('does not include body for GET requests', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(200)));

      const req = makeReq('/api/wallet', 'GET', { some: 'body' });
      const res = makeRes();

      await service.forward(req, res);

      const callConfig = mockHttp.request.mock.calls[0][0];
      expect(callConfig.data).toBeUndefined();
    });
  });

  // ── forward — user context headers ─────────────────────────────────────────

  describe('forward — user context headers', () => {
    it('injects x-user-id, x-user-role, x-user-kyc-tier when user present', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(200)));

      const user = { sub: 'user-1', role: 'USER', kycTier: 1 };
      const req = makeReq('/api/trades', 'GET', {}, user);
      const res = makeRes();

      await service.forward(req, res, user as any);

      const callConfig = mockHttp.request.mock.calls[0][0];
      expect(callConfig.headers['x-user-id']).toBe('user-1');
      expect(callConfig.headers['x-user-role']).toBe('USER');
      expect(callConfig.headers['x-user-kyc-tier']).toBe('1');
    });

    it('omits user headers when no user provided', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(200)));

      const req = makeReq('/api/markets', 'GET');
      const res = makeRes();

      await service.forward(req, res); // no user arg

      const callConfig = mockHttp.request.mock.calls[0][0];
      expect(callConfig.headers['x-user-id']).toBeUndefined();
      expect(callConfig.headers['x-user-role']).toBeUndefined();
    });

    it('always forwards x-internal-key', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(200)));

      await service.forward(makeReq('/api/auth/login'), makeRes());

      const callConfig = mockHttp.request.mock.calls[0][0];
      expect(callConfig.headers['x-internal-key']).toBeDefined();
    });
  });

  // ── forward — query strings ─────────────────────────────────────────────────

  describe('forward — query string preservation', () => {
    it('appends query string to proxied URL', async () => {
      mockHttp.request.mockReturnValue(of(axiosRaw(200)));

      const req = { ...makeReq('/api/markets'), url: '/api/markets?page=2&limit=10' };
      const res = makeRes();

      await service.forward(req, res);

      const callConfig = mockHttp.request.mock.calls[0][0];
      expect(callConfig.url).toContain('page=2');
      expect(callConfig.url).toContain('limit=10');
    });
  });

  // ── forward — 502 on error ──────────────────────────────────────────────────

  describe('forward — 502 on error', () => {
    it('returns 502 when downstream throws', async () => {
      mockHttp.request.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

      const req = makeReq('/api/auth/login');
      const res = makeRes();

      await service.forward(req, res);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502 }));
    });
  });

  // ── route prefix matching ───────────────────────────────────────────────────

  describe('route prefix matching', () => {
    const routes = [
      { path: '/api/auth/login', service: '3001' },
      { path: '/api/users/me', service: '3002' },
      { path: '/api/markets/active', service: '3003' },
      { path: '/api/trades', service: '3004' },
      { path: '/api/wallet/balance', service: '3005' },
      { path: '/api/payments/deposit', service: '3006' },
      { path: '/api/notifications', service: '3007' },
      { path: '/api/callbacks/mpesa/stk', service: '3006' },
    ];

    routes.forEach(({ path, service: port }) => {
      it(`routes ${path} to service on port ${port}`, async () => {
        mockHttp.request.mockReturnValue(of(axiosRaw(200)));

        await service.forward(makeReq(path), makeRes());

        const callConfig = mockHttp.request.mock.calls[0][0];
        expect(callConfig.url).toContain(port);
      });
    });
  });
});
