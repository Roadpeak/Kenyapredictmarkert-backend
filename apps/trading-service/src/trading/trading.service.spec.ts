import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosResponse, AxiosHeaders } from 'axios';
import { TradingService } from './trading.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  trade: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  marketPool: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  position: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  settlement: {
    upsert: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockKafka = {
  publish: jest.fn().mockResolvedValue(undefined),
  publishBatch: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(),
};

const mockHttp = { post: jest.fn(), get: jest.fn() };
const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? 'http://localhost:3005'),
};

jest.mock('@org/utils', () => ({
  calcYesPrice: jest.fn(() => 0.6),
  calcNoPrice: jest.fn(() => 0.4),
  calcSharesReceived: jest.fn((amount: number) => amount / 10),
  calcPayoutPerShare: jest.fn(() => 96),
  generateSettlementId: jest.fn(() => 'settlement-id-hash'),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

const makePool = (overrides = {}) => ({
  id: 'pool-1',
  marketId: 'market-1',
  poolYesKes: 1000,
  poolNoKes: 1000,
  totalShares: 200,
  yesShares: 100,
  noShares: 100,
  rake: 0.04,
  version: 0,
  ...overrides,
});

const makePosition = (overrides = {}) => ({
  id: 'pos-1',
  userId: 'user-1',
  marketId: 'market-1',
  outcome: 'YES',
  totalShares: 100,
  totalCostKes: 1000,
  avgPriceKes: 0.5,
  isSettled: false,
  payoutKes: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeTrade = (overrides = {}) => ({
  id: 'trade-1',
  userId: 'user-1',
  marketId: 'market-1',
  outcome: 'YES',
  amountKes: 100,
  sharesReceived: 10,
  pricePerShare: 0.6,
  poolYesAtTrade: 1000,
  poolNoAtTrade: 1000,
  status: 'CONFIRMED',
  idempotencyKey: 'idem-key-1',
  createdAt: new Date(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TradingService', () => {
  let service: TradingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKafka.publish.mockResolvedValue(undefined);
    mockKafka.publishBatch.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KafkaService, useValue: mockKafka },
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<TradingService>(TradingService);
  });

  // ── placeTrade — idempotency ────────────────────────────────────────────────

  describe('placeTrade — idempotency', () => {
    const dto = { marketId: 'market-1', outcome: 'YES', amountKes: 100, idempotencyKey: 'idem-key-1' };

    it('returns existing trade when same idempotencyKey used by same user', async () => {
      const existing = makeTrade();
      mockPrisma.trade.findUnique.mockResolvedValue(existing);

      const result = await service.placeTrade('user-1', dto as any);
      expect(result).toEqual(existing);
      expect(mockHttp.get).not.toHaveBeenCalled(); // no market check needed
    });

    it('throws BadRequestException when idempotencyKey belongs to different user', async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ userId: 'other-user' }));
      await expect(service.placeTrade('user-1', dto as any)).rejects.toThrow(BadRequestException);
    });
  });

  // ── placeTrade — success ────────────────────────────────────────────────────

  describe('placeTrade — success path', () => {
    const dto = { marketId: 'market-1', outcome: 'YES', amountKes: 100, idempotencyKey: 'idem-key-new' };

    beforeEach(() => {
      mockPrisma.trade.findUnique.mockResolvedValue(null); // no duplicate
      // market is ACTIVE
      mockHttp.get.mockReturnValue(of(axiosResponse({ status: 'ACTIVE', id: 'market-1' })));
      // wallet reserve succeeds
      mockHttp.post.mockReturnValue(of(axiosResponse({ success: true })));
      // transaction: pool update + trade create
      mockPrisma.$transaction.mockImplementation(async (ops: any[]) => {
        return [{ ...makePool(), version: 1 }, makeTrade()];
      });
      // position upsert
      mockPrisma.position.findUnique.mockResolvedValue(null); // new position
      mockPrisma.position.upsert.mockResolvedValue(makePosition());
      // pool for notification
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ version: 1 }));
    });

    it('creates trade and returns confirmation', async () => {
      const result = await service.placeTrade('user-1', dto as any);
      expect(result).toMatchObject({
        tradeId: expect.any(String),
        status: 'CONFIRMED',
        amountKes: 100,
        sharesReceived: 10,
      });
    });

    it('publishes TRADE_CONFIRMED and ANALYTICS_TRADE_EVENT Kafka events', async () => {
      await service.placeTrade('user-1', dto as any);
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('trade-confirmed'),
        expect.objectContaining({ userId: 'user-1', marketId: 'market-1' }),
        expect.any(String),
      );
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('analytics'),
        expect.objectContaining({ tradeId: expect.any(String) }),
      );
    });

    it('calls wallet reserve before touching pool', async () => {
      await service.placeTrade('user-1', dto as any);
      // First post call should be to reserve endpoint
      expect(mockHttp.post).toHaveBeenCalledWith(
        expect.stringContaining('/internal/wallet/reserve'),
        expect.objectContaining({ userId: 'user-1', amount: 100 }),
      );
    });
  });

  // ── placeTrade — market not active ─────────────────────────────────────────

  describe('placeTrade — market not active', () => {
    it('throws BadRequestException when market is CLOSED', async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(of(axiosResponse({ status: 'CLOSED', id: 'market-1' })));
      mockHttp.post.mockReturnValue(of(axiosResponse({ success: true }))); // reserve still called first

      await expect(
        service.placeTrade('user-1', { marketId: 'market-1', outcome: 'YES', amountKes: 100, idempotencyKey: 'k1' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when market service returns 404', async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(null);
      const err = { response: { status: 404 } };
      mockHttp.get.mockReturnValue(throwError(() => err));
      mockHttp.post.mockReturnValue(of(axiosResponse({ success: true })));

      await expect(
        service.placeTrade('user-1', { marketId: 'bad-id', outcome: 'YES', amountKes: 100, idempotencyKey: 'k2' } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── placeTrade — wallet insufficient ───────────────────────────────────────

  describe('placeTrade — insufficient wallet', () => {
    it('throws BadRequestException when wallet reserve fails', async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(of(axiosResponse({ status: 'ACTIVE', id: 'market-1' })));
      mockHttp.post.mockReturnValue(
        throwError(() => ({ response: { data: { message: 'Insufficient balance' } } })),
      );

      await expect(
        service.placeTrade('user-1', { marketId: 'market-1', outcome: 'YES', amountKes: 99999, idempotencyKey: 'k3' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getMyTrades ─────────────────────────────────────────────────────────────

  describe('getMyTrades', () => {
    it('returns paginated trade history', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([makeTrade()]);
      mockPrisma.trade.count.mockResolvedValue(1);

      const result = await service.getMyTrades('user-1');
      expect(result).toMatchObject({ data: expect.any(Array), meta: expect.objectContaining({ total: 1 }) });
    });

    it('filters by marketId when provided', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([]);
      mockPrisma.trade.count.mockResolvedValue(0);

      await service.getMyTrades('user-1', 1, 20, 'market-1');
      expect(mockPrisma.trade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ marketId: 'market-1' }) }),
      );
    });
  });

  // ── getMyPositions ──────────────────────────────────────────────────────────

  describe('getMyPositions', () => {
    it('enriches positions with current price and P&L', async () => {
      mockPrisma.position.findMany.mockResolvedValue([makePosition()]);
      mockPrisma.marketPool.findMany.mockResolvedValue([makePool()]);

      const result = await service.getMyPositions('user-1');
      expect(result[0]).toMatchObject({
        currentPrice: expect.any(Number),
        currentValue: expect.any(Number),
        unrealizedPnl: expect.any(Number),
      });
    });

    it('returns empty array when no open positions', async () => {
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.marketPool.findMany.mockResolvedValue([]);

      const result = await service.getMyPositions('user-1');
      expect(result).toEqual([]);
    });
  });

  // ── getMarketTrades ─────────────────────────────────────────────────────────

  describe('getMarketTrades', () => {
    it('returns anonymized public trade list', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([
        { outcome: 'YES', amountKes: 100, pricePerShare: 0.6, createdAt: new Date() },
      ]);
      mockPrisma.trade.count.mockResolvedValue(1);

      const result = await service.getMarketTrades('market-1');
      expect(result.data[0]).not.toHaveProperty('userId');
    });
  });

  // ── settleMarket ────────────────────────────────────────────────────────────

  describe('settleMarket', () => {
    const payload = {
      marketId: 'market-1',
      marketTitle: 'Test Market',
      outcome: 'YES',
      totalPoolKes: 5000,
      rake: 0.04,
      resolvedAt: new Date().toISOString(),
    };

    it('fans out one settlement message per winner', async () => {
      mockPrisma.position.findMany.mockResolvedValue(
        [makePosition({ userId: 'user-1', totalShares: 100 }), makePosition({ userId: 'user-2', id: 'pos-2', totalShares: 50 })],
      );
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ yesShares: 150 }));
      mockPrisma.settlement.upsert.mockResolvedValue({});
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.position.updateMany.mockResolvedValue({ count: 0 });

      await service.settleMarket(payload as any);

      expect(mockKafka.publishBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ payload: expect.objectContaining({ userId: 'user-1' }) }),
          expect.objectContaining({ payload: expect.objectContaining({ userId: 'user-2' }) }),
        ]),
      );
    });

    it('skips fan-out when no winning positions', async () => {
      mockPrisma.position.findMany.mockResolvedValue([]);
      await service.settleMarket(payload as any);
      expect(mockKafka.publishBatch).not.toHaveBeenCalled();
    });

    it('marks losing positions as settled with payoutKes 0', async () => {
      mockPrisma.position.findMany.mockResolvedValue([makePosition({ totalShares: 100 })]);
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ yesShares: 100 }));
      mockPrisma.settlement.upsert.mockResolvedValue({});
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.position.updateMany.mockResolvedValue({ count: 2 });

      await service.settleMarket(payload as any);

      expect(mockPrisma.position.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isSettled: true, payoutKes: 0 } }),
      );
    });
  });

  // ── refundMarket ────────────────────────────────────────────────────────────

  describe('refundMarket', () => {
    it('publishes WALLET_CREDITED for each position and marks settled', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ userId: 'user-1', totalCostKes: 500 }),
        makePosition({ id: 'pos-2', userId: 'user-2', totalCostKes: 300 }),
      ]);
      mockPrisma.position.updateMany.mockResolvedValue({ count: 2 });

      await service.refundMarket({ marketId: 'market-1', cancelledAt: new Date().toISOString() });

      expect(mockKafka.publish).toHaveBeenCalledTimes(2);
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('wallet.credited'),
        expect.objectContaining({ userId: 'user-1', amount: 500 }),
        expect.any(String),
      );
    });

    it('marks all positions as settled with zero payout', async () => {
      mockPrisma.position.findMany.mockResolvedValue([makePosition()]);
      mockPrisma.position.updateMany.mockResolvedValue({ count: 1 });

      await service.refundMarket({ marketId: 'market-1', cancelledAt: new Date().toISOString() });

      expect(mockPrisma.position.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isSettled: true, payoutKes: 0 } }),
      );
    });
  });

  // ── initMarketPool ──────────────────────────────────────────────────────────

  describe('initMarketPool', () => {
    it('upserts pool with seed values', async () => {
      mockPrisma.marketPool.upsert.mockResolvedValue({});
      await service.initMarketPool('market-1', 1000, 1000, 0.04);
      expect(mockPrisma.marketPool.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { marketId: 'market-1' },
          create: expect.objectContaining({ poolYesKes: 1000, poolNoKes: 1000, rake: 0.04 }),
        }),
      );
    });
  });
});
