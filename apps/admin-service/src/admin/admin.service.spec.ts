import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { AdminService } from './admin.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockHttp = { get: jest.fn(), post: jest.fn(), put: jest.fn() };

const mockConfig = {
  get: jest.fn((key: string, def?: string) => {
    const map: Record<string, string> = {
      INTERNAL_API_KEY: 'test-internal-key',
      MARKET_SERVICE_URL: 'http://localhost:3003',
      USER_SERVICE_URL: 'http://localhost:3002',
    };
    return map[key] ?? def ?? '';
  }),
  getOrThrow: jest.fn((key: string) => `value-for-${key}`),
};

function axiosOk<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  // ── createMarket ────────────────────────────────────────────────────────────

  describe('createMarket', () => {
    const dto = {
      title: 'Will it rain?',
      description: 'Nairobi weather',
      closesAt: '2026-12-01T00:00:00Z',
      seedYesKes: 1000,
      seedNoKes: 1000,
    };

    it('POSTs to market-service and returns response', async () => {
      const marketData = { id: 'market-1', title: dto.title };
      mockHttp.post.mockReturnValue(of(axiosOk(marketData)));

      const result = await service.createMarket(dto as any, 'admin-token');

      expect(result).toEqual(marketData);
      expect(mockHttp.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/markets'),
        dto,
        expect.objectContaining({ headers: expect.objectContaining({ 'x-internal-key': 'test-internal-key', authorization: 'Bearer admin-token' }) }),
      );
    });

    it('throws BadRequestException on downstream error', async () => {
      mockHttp.post.mockReturnValue(throwError(() => new Error('Service unavailable')));
      await expect(service.createMarket(dto as any, 'admin-token')).rejects.toThrow(BadRequestException);
    });
  });

  // ── activateMarket ──────────────────────────────────────────────────────────

  describe('activateMarket', () => {
    it('PUTs to activate endpoint', async () => {
      mockHttp.put.mockReturnValue(of(axiosOk({ status: 'ACTIVE' })));

      const result = await service.activateMarket('market-1', 'admin-token');

      expect(result).toMatchObject({ status: 'ACTIVE' });
      expect(mockHttp.put).toHaveBeenCalledWith(
        expect.stringContaining('/market-1/activate'),
        {},
        expect.anything(),
      );
    });
  });

  // ── resolveMarket ───────────────────────────────────────────────────────────

  describe('resolveMarket', () => {
    it('PUTs outcome to resolve endpoint', async () => {
      mockHttp.put.mockReturnValue(of(axiosOk({ status: 'RESOLVED' })));

      await service.resolveMarket('market-1', { outcome: 'YES' }, 'admin-token');

      expect(mockHttp.put).toHaveBeenCalledWith(
        expect.stringContaining('/market-1/resolve'),
        { outcome: 'YES' },
        expect.anything(),
      );
    });
  });

  // ── cancelMarket ────────────────────────────────────────────────────────────

  describe('cancelMarket', () => {
    it('PUTs to cancel endpoint', async () => {
      mockHttp.put.mockReturnValue(of(axiosOk({ status: 'CANCELLED' })));
      await service.cancelMarket('market-1', 'admin-token');
      expect(mockHttp.put).toHaveBeenCalledWith(
        expect.stringContaining('/market-1/cancel'),
        {},
        expect.anything(),
      );
    });
  });

  // ── listMarkets ─────────────────────────────────────────────────────────────

  describe('listMarkets', () => {
    it('GETs markets with pagination query params', async () => {
      mockHttp.get.mockReturnValue(of(axiosOk({ data: [], meta: { total: 0 } })));

      await service.listMarkets('ACTIVE', 2, 10, 'admin-token');

      expect(mockHttp.get).toHaveBeenCalledWith(
        expect.stringContaining('page=2'),
        expect.anything(),
      );
      expect(mockHttp.get).toHaveBeenCalledWith(
        expect.stringContaining('status=ACTIVE'),
        expect.anything(),
      );
    });
  });

  // ── approveKyc ──────────────────────────────────────────────────────────────

  describe('approveKyc', () => {
    it('PUTs to user kyc approve endpoint', async () => {
      mockHttp.put.mockReturnValue(of(axiosOk({ kycTier: 2 })));

      await service.approveKyc('user-1', 'admin-token');

      expect(mockHttp.put).toHaveBeenCalledWith(
        expect.stringContaining('/users/user-1/kyc/approve'),
        {},
        expect.anything(),
      );
    });
  });

  // ── rejectKyc ───────────────────────────────────────────────────────────────

  describe('rejectKyc', () => {
    it('PUTs rejection note to user kyc reject endpoint', async () => {
      mockHttp.put.mockReturnValue(of(axiosOk({ kycTier: 0 })));

      await service.rejectKyc('user-1', 'Bad document quality', 'admin-token');

      expect(mockHttp.put).toHaveBeenCalledWith(
        expect.stringContaining('/users/user-1/kyc/reject'),
        { note: 'Bad document quality' },
        expect.anything(),
      );
    });
  });

  // ── suspendUser / unsuspendUser ─────────────────────────────────────────────

  describe('suspendUser', () => {
    it('POSTs to user suspend endpoint', async () => {
      mockHttp.post.mockReturnValue(of(axiosOk({ suspended: true })));

      await service.suspendUser('user-1', 'admin-token');

      expect(mockHttp.post).toHaveBeenCalledWith(
        expect.stringContaining('/users/user-1/suspend'),
        {},
        expect.anything(),
      );
    });
  });

  describe('unsuspendUser', () => {
    it('POSTs to user unsuspend endpoint', async () => {
      mockHttp.post.mockReturnValue(of(axiosOk({ suspended: false })));

      await service.unsuspendUser('user-1', 'admin-token');

      expect(mockHttp.post).toHaveBeenCalledWith(
        expect.stringContaining('/users/user-1/unsuspend'),
        {},
        expect.anything(),
      );
    });
  });

  // ── headers forwarding ──────────────────────────────────────────────────────

  describe('headers', () => {
    it('always includes x-internal-key', async () => {
      mockHttp.get.mockReturnValue(of(axiosOk({})));

      await service.listUsers(1, 20, 'token-123');

      const callConfig = mockHttp.get.mock.calls[0][1];
      expect(callConfig.headers['x-internal-key']).toBe('test-internal-key');
    });

    it('includes authorization header when token provided', async () => {
      mockHttp.get.mockReturnValue(of(axiosOk({})));

      await service.listUsers(1, 20, 'my-token');

      const callConfig = mockHttp.get.mock.calls[0][1];
      expect(callConfig.headers.authorization).toBe('Bearer my-token');
    });

    it('omits authorization header when no token', async () => {
      mockHttp.get.mockReturnValue(of(axiosOk({})));

      await service.listUsers(1, 20);

      const callConfig = mockHttp.get.mock.calls[0][1];
      expect(callConfig.headers.authorization).toBeUndefined();
    });
  });
});
