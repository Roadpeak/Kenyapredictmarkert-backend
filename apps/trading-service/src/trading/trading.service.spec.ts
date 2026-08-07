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
  optionPool: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    count: jest.fn(),
  },
  optionPosition: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  optionTrade: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
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
  getOrThrow: jest.fn((key: string) =>
    key === 'INTERNAL_API_KEY' ? 'test-internal-key' : 'http://localhost:3005',
  ),
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

    it('includes marketTitle and sharesCount in TRADE_CONFIRMED — the notification consumer reads these exact field names and previously got undefined for both', async () => {
      mockHttp.get.mockReturnValue(of(axiosResponse({ status: 'ACTIVE', id: 'market-1', title: 'Will it rain tomorrow?' })));

      await service.placeTrade('user-1', dto as any);

      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('trade-confirmed'),
        expect.objectContaining({ marketTitle: 'Will it rain tomorrow?', sharesCount: 10 }),
        expect.any(String),
      );
    });

    it('calls wallet reserve before touching pool', async () => {
      await service.placeTrade('user-1', dto as any);
      // First post call should be to reserve endpoint
      expect(mockHttp.post).toHaveBeenCalledWith(
        expect.stringContaining('/internal/wallet/reserve'),
        expect.objectContaining({ userId: 'user-1', amount: 100 }),
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-internal-key': 'test-internal-key' }),
        }),
      );
    });

    it('releases the reserve after debiting so funds are not left locked', async () => {
      await service.placeTrade('user-1', dto as any);

      const endpoints = mockHttp.post.mock.calls.map((c: unknown[]) => String(c[0]));
      const debitIdx = endpoints.findIndex((u) => u.includes('/internal/wallet/debit'));
      const releaseIdx = endpoints.findIndex((u) => u.includes('/internal/wallet/release'));

      // debit only moves `balance` — without the release the reserved amount
      // stays on the wallet forever and permanently locks the funds.
      expect(debitIdx).toBeGreaterThanOrEqual(0);
      expect(releaseIdx).toBeGreaterThan(debitIdx);
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

    it('throws BadRequestException when the market is ACTIVE but closesAt has already passed — previously nothing enforced this and trades kept going through indefinitely', async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(
        of(axiosResponse({ status: 'ACTIVE', id: 'market-1', closesAt: '2020-01-01T00:00:00.000Z' })),
      );
      mockHttp.post.mockReturnValue(of(axiosResponse({ success: true })));

      await expect(
        service.placeTrade('user-1', { marketId: 'market-1', outcome: 'YES', amountKes: 100, idempotencyKey: 'k3' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows the trade when the market is ACTIVE and closesAt is still in the future', async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(
        of(axiosResponse({ status: 'ACTIVE', id: 'market-1', closesAt: '2099-01-01T00:00:00.000Z' })),
      );
      mockHttp.post.mockReturnValue(of(axiosResponse({ success: true })));
      mockPrisma.$transaction.mockImplementation(async () => {
        return [{ ...makePool(), version: 1 }, makeTrade()];
      });
      mockPrisma.position.findUnique.mockResolvedValue(null);
      mockPrisma.position.upsert.mockResolvedValue(makePosition());
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ version: 1 }));

      await expect(
        service.placeTrade('user-1', { marketId: 'market-1', outcome: 'YES', amountKes: 100, idempotencyKey: 'k4' } as any),
      ).resolves.toMatchObject({ marketId: 'market-1' });
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

  // ── placeOptionTrade — success ──────────────────────────────────────────────

  describe('placeOptionTrade — success path', () => {
    const dto = { marketId: 'market-1', optionId: 'opt-a', amountKes: 300, idempotencyKey: 'idem-opt-1' };

    const makeOptionTrade = (overrides = {}) => ({
      id: 'otrade-1',
      userId: 'user-1',
      marketId: 'market-1',
      optionId: 'opt-a',
      label: 'A',
      amountKes: 300,
      sharesReceived: 30,
      pricePerShare: 0.3333,
      status: 'CONFIRMED',
      ...overrides,
    });

    beforeEach(() => {
      mockPrisma.optionTrade.findUnique.mockResolvedValue(null); // no duplicate
      mockPrisma.optionPool.findUnique.mockResolvedValue({
        optionId: 'opt-a', marketId: 'market-1', label: 'A', poolKes: 100, rake: 0.04, version: 0,
      });
      mockHttp.post.mockReturnValue(of(axiosResponse({ success: true }))); // wallet reserve/debit/release
      mockHttp.get.mockReturnValue(of(axiosResponse({ status: 'ACTIVE', id: 'market-1' })));
      // executeOptionTrade's transaction — mocked to resolve directly, same
      // pattern as placeTrade's success-path test above.
      mockPrisma.$transaction.mockImplementation(async () => makeOptionTrade());
      // notifyOptionPoolUpdate reads all pools for the market after the trade
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', poolKes: 400, totalShares: 30 },
        { optionId: 'opt-b', poolKes: 100, totalShares: 0 },
      ]);
    });

    it('creates the option trade and returns confirmation', async () => {
      const result = await service.placeOptionTrade('user-1', dto);
      expect(result).toMatchObject({ label: 'A', amountKes: 300, sharesReceived: 30, status: 'CONFIRMED' });
    });

    it('includes marketTitle and sharesCount in TRADE_CONFIRMED for a MULTI trade too', async () => {
      mockHttp.get.mockReturnValue(of(axiosResponse({ status: 'ACTIVE', id: 'market-1', title: "Who wins the Ballon d'Or?" })));

      await service.placeOptionTrade('user-1', dto);

      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('trade-confirmed'),
        expect.objectContaining({ marketTitle: "Who wins the Ballon d'Or?", sharesCount: 30, outcome: 'A' }),
        expect.any(String),
      );
    });

    it('publishes MARKET_OPTION_PRICE_UPDATED with every option in the market, not just the traded one', async () => {
      await service.placeOptionTrade('user-1', dto);
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('option-price-updated'),
        expect.objectContaining({
          marketId: 'market-1',
          volumeDelta: 300,
          options: [
            { optionId: 'opt-a', poolKes: 400, totalShares: 30 },
            { optionId: 'opt-b', poolKes: 100, totalShares: 0 },
          ],
        }),
        'market-1',
      );
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

  // ── getMyOptionTrades ────────────────────────────────────────────────────────

  describe('getMyOptionTrades', () => {
    it('returns paginated option-trade history', async () => {
      mockPrisma.optionTrade.findMany.mockResolvedValue([
        { id: 'otr-1', userId: 'user-1', marketId: 'market-1', optionId: 'opt-a', label: 'A' },
      ]);
      mockPrisma.optionTrade.count.mockResolvedValue(1);

      const result = await service.getMyOptionTrades('user-1');
      expect(result).toMatchObject({ data: expect.any(Array), meta: expect.objectContaining({ total: 1 }) });
    });

    it('filters by marketId when provided', async () => {
      mockPrisma.optionTrade.findMany.mockResolvedValue([]);
      mockPrisma.optionTrade.count.mockResolvedValue(0);

      await service.getMyOptionTrades('user-1', 1, 20, 'market-1');
      expect(mockPrisma.optionTrade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ marketId: 'market-1' }) }),
      );
    });
  });

  // ── getMyOptionPositions ─────────────────────────────────────────────────────

  describe('getMyOptionPositions', () => {
    it('prices positions across multiple markets using each market\'s own pool total', async () => {
      mockPrisma.optionPosition.findMany.mockResolvedValue([
        {
          id: 'opos-1', userId: 'user-1', marketId: 'market-1', optionId: 'opt-a', label: 'A',
          totalShares: 100, totalCostKes: 1000, avgPriceKes: 0.5, isSettled: false,
        },
        {
          id: 'opos-2', userId: 'user-1', marketId: 'market-2', optionId: 'opt-x', label: 'X',
          totalShares: 50, totalCostKes: 400, avgPriceKes: 0.4, isSettled: false,
        },
      ]);
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', marketId: 'market-1', poolKes: 3000 },
        { optionId: 'opt-b', marketId: 'market-1', poolKes: 1000 },
        { optionId: 'opt-x', marketId: 'market-2', poolKes: 500 },
        { optionId: 'opt-y', marketId: 'market-2', poolKes: 500 },
      ]);

      const result = await service.getMyOptionPositions('user-1');
      expect(result).toEqual([
        expect.objectContaining({ marketId: 'market-1', optionId: 'opt-a', currentPrice: 0.75 }),
        expect.objectContaining({ marketId: 'market-2', optionId: 'opt-x', currentPrice: 0.5 }),
      ]);
    });

    it('returns empty array and skips the pool lookup when no open positions', async () => {
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);

      const result = await service.getMyOptionPositions('user-1');
      expect(result).toEqual([]);
      expect(mockPrisma.optionPool.findMany).not.toHaveBeenCalled();
    });
  });

  // ── getMyPositions ──────────────────────────────────────────────────────────

  describe('getMyPositions', () => {
    it('enriches positions with current price, P&L, and the resolved market title', async () => {
      mockPrisma.position.findMany.mockResolvedValue([makePosition()]);
      mockPrisma.marketPool.findMany.mockResolvedValue([makePool()]);
      mockHttp.get.mockReturnValue(
        of(axiosResponse([{ id: 'market-1', title: "Will it rain tomorrow?" }])),
      );

      const result = await service.getMyPositions('user-1');
      expect(result[0]).toMatchObject({
        marketTitle: "Will it rain tomorrow?",
        currentPrice: expect.any(Number),
        currentValue: expect.any(Number),
        unrealizedPnl: expect.any(Number),
      });
    });

    it('returns sharesHeld/costKes as real numbers, not the raw Decimal-as-string columns — previously the portfolio page rendered NaN for both', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ totalShares: 100, totalCostKes: 1000 }),
      ]);
      mockPrisma.marketPool.findMany.mockResolvedValue([makePool()]);
      mockHttp.get.mockReturnValue(of(axiosResponse([])));

      const result = await service.getMyPositions('user-1');

      expect(result[0].sharesHeld).toBe(100);
      expect(result[0].costKes).toBe(1000);
      expect(typeof result[0].sharesHeld).toBe('number');
      expect(typeof result[0].costKes).toBe('number');
    });

    it('falls back to the raw marketId when market-service is unreachable — previously this field was missing entirely, showing blank in the UI', async () => {
      mockPrisma.position.findMany.mockResolvedValue([makePosition()]);
      mockPrisma.marketPool.findMany.mockResolvedValue([makePool()]);
      mockHttp.get.mockReturnValue(throwError(() => new Error('Connection refused')));

      const result = await service.getMyPositions('user-1');
      expect(result[0].marketTitle).toBe(result[0].marketId);
    });

    it('returns empty array when no open positions', async () => {
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.marketPool.findMany.mockResolvedValue([]);

      const result = await service.getMyPositions('user-1');
      expect(result).toEqual([]);
    });
  });

  // ── getMyResults ─────────────────────────────────────────────────────────────

  describe('getMyResults', () => {
    it('merges settled binary and option positions, newest first, with resolved market titles — previously settled positions were unreachable from any endpoint', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({
          id: 'pos-1', marketId: 'market-1', outcome: 'YES', isSettled: true,
          payoutKes: 960, totalCostKes: 500, totalShares: 100,
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([
        {
          id: 'opos-1', marketId: 'market-2', optionId: 'opt-a', label: 'Haaland',
          isSettled: true, payoutKes: 0, totalCostKes: 300, totalShares: 30,
          updatedAt: new Date('2026-08-02T00:00:00.000Z'),
        },
      ]);
      mockHttp.get.mockReturnValue(
        of(axiosResponse([
          { id: 'market-1', title: 'Will it rain tomorrow?' },
          { id: 'market-2', title: "Who wins the Ballon d'Or?" },
        ])),
      );

      const result = await service.getMyResults('user-1', 1, 20);

      expect(result.total).toBe(2);
      // Newest settlement first: market-2 settled 2026-08-02, market-1 on 08-01.
      expect(result.data[0]).toMatchObject({
        marketId: 'market-2',
        marketTitle: "Who wins the Ballon d'Or?",
        label: 'Haaland',
        payoutKes: 0,
        won: false,
      });
      expect(result.data[1]).toMatchObject({
        marketId: 'market-1',
        marketTitle: 'Will it rain tomorrow?',
        label: 'YES',
        payoutKes: 960,
        won: true,
      });
    });

    it('paginates the merged, sorted results', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ id: 'pos-1', marketId: 'm1', isSettled: true, payoutKes: 100, updatedAt: new Date('2026-08-01') }),
        makePosition({ id: 'pos-2', marketId: 'm2', isSettled: true, payoutKes: 0, updatedAt: new Date('2026-08-02') }),
      ]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);
      mockHttp.get.mockReturnValue(of(axiosResponse([])));

      const result = await service.getMyResults('user-1', 1, 1);

      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].marketId).toBe('m2');
    });

    it('returns empty when nothing has settled yet', async () => {
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);

      const result = await service.getMyResults('user-1', 1, 20);
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });
  });

  // ── getMarketRoster ──────────────────────────────────────────────────────────

  describe('getMarketRoster', () => {
    it('lists every staker on a live market with real identity, largest stake first — the admin counterpart to the anonymized public trade list', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ userId: 'user-1', outcome: 'YES', totalCostKes: 100, totalShares: 10, isSettled: false, payoutKes: null }),
      ]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([
        {
          id: 'opos-1', userId: 'user-2', marketId: 'market-1', optionId: 'opt-a', label: 'Haaland',
          totalShares: 30, totalCostKes: 300, isSettled: false, payoutKes: null, updatedAt: new Date(),
        },
      ]);
      mockHttp.get.mockReturnValue(of(axiosResponse({ 'user-1': 'Alice', 'user-2': 'Bob' })));

      const result = await service.getMarketRoster('market-1', 1, 20);

      expect(result.total).toBe(2);
      expect(result.data[0]).toMatchObject({ userId: 'user-2', displayName: 'Bob', costKes: 300, isSettled: false, won: null });
      expect(result.data[1]).toMatchObject({ userId: 'user-1', displayName: 'Alice', costKes: 100, isSettled: false, won: null });
    });

    it('reports won/lost and payout for a resolved market, plus winner/loser counts and totals', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ userId: 'user-1', outcome: 'YES', totalCostKes: 100, isSettled: true, payoutKes: 240 }),
        makePosition({ userId: 'user-2', outcome: 'NO', totalCostKes: 50, isSettled: true, payoutKes: 0 }),
      ]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);
      mockHttp.get.mockReturnValue(of(axiosResponse({ 'user-1': 'Alice', 'user-2': 'Bob' })));

      const result = await service.getMarketRoster('market-1', 1, 20);

      expect(result.winnerCount).toBe(1);
      expect(result.loserCount).toBe(1);
      expect(result.totalStakedKes).toBe(150);
      expect(result.totalPaidOutKes).toBe(240);
      const winner = result.data.find((r) => r.userId === 'user-1');
      const loser = result.data.find((r) => r.userId === 'user-2');
      expect(winner).toMatchObject({ won: true, payoutKes: 240 });
      expect(loser).toMatchObject({ won: false, payoutKes: 0 });
    });

    it('paginates the roster', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ id: 'p1', userId: 'a', totalCostKes: 300 }),
        makePosition({ id: 'p2', userId: 'b', totalCostKes: 200 }),
        makePosition({ id: 'p3', userId: 'c', totalCostKes: 100 }),
      ]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);
      mockHttp.get.mockReturnValue(of(axiosResponse({})));

      const result = await service.getMarketRoster('market-1', 2, 1);

      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].userId).toBe('b');
    });

    it('returns an empty roster with zeroed totals when nobody has staked', async () => {
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);

      const result = await service.getMarketRoster('market-1', 1, 20);

      expect(result).toMatchObject({
        data: [], total: 0, winnerCount: 0, loserCount: 0, totalStakedKes: 0, totalPaidOutKes: 0,
      });
    });
  });

  // ── getMarketHolders ─────────────────────────────────────────────────────────

  describe('getMarketHolders', () => {
    it('ranks binary holders by CURRENT position value (not cost), split into yes/no — the public, identity-revealing counterpart to Top Holders', async () => {
      mockPrisma.optionPool.count.mockResolvedValue(0); // binary market
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ userId: 'user-1', outcome: 'YES', totalShares: 10, totalCostKes: 100 }),
        makePosition({ userId: 'user-2', outcome: 'YES', totalShares: 50, totalCostKes: 400 }),
        makePosition({ userId: 'user-3', outcome: 'NO', totalShares: 20, totalCostKes: 150 }),
      ]);
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ poolYesKes: 1500, poolNoKes: 1000 }));
      mockHttp.get.mockReturnValue(
        of(axiosResponse({ 'user-1': 'Alice', 'user-2': 'Bob', 'user-3': 'Carol' })),
      );

      const result = await service.getMarketHolders('market-1');

      expect(result.marketType).toBe('BINARY');
      if (result.marketType !== 'BINARY') throw new Error('expected BINARY');

      // yesPrice = 1500/2500 = 0.6 -> user-2: 50*10*0.6=300, user-1: 10*10*0.6=60
      expect(result.yes).toHaveLength(2);
      expect(result.yes[0]).toMatchObject({ userId: 'user-2', displayName: 'Bob', currentValue: 300 });
      expect(result.yes[1]).toMatchObject({ userId: 'user-1', displayName: 'Alice', currentValue: 60 });

      // noPrice = 1000/2500 = 0.4 -> user-3: 20*10*0.4=80
      expect(result.no).toHaveLength(1);
      expect(result.no[0]).toMatchObject({ userId: 'user-3', displayName: 'Carol', currentValue: 80 });
    });

    it('caps each side at the top 50 holders by current value', async () => {
      mockPrisma.optionPool.count.mockResolvedValue(0);
      const positions = Array.from({ length: 60 }, (_, i) =>
        makePosition({ id: `pos-${i}`, userId: `user-${i}`, outcome: 'YES', totalShares: i + 1, totalCostKes: (i + 1) * 10 }),
      );
      mockPrisma.position.findMany.mockResolvedValue(positions);
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ poolYesKes: 1000, poolNoKes: 1000 }));
      mockHttp.get.mockReturnValue(of(axiosResponse({})));

      const result = await service.getMarketHolders('market-1');
      if (result.marketType !== 'BINARY') throw new Error('expected BINARY');

      expect(result.yes).toHaveLength(50);
      // Highest shares (user-59, 60 shares) should rank first.
      expect(result.yes[0].userId).toBe('user-59');
    });

    it('ranks MULTI holders per option, grouped by each runner\'s own pool share', async () => {
      mockPrisma.optionPool.count.mockResolvedValue(2); // MULTI market
      mockPrisma.optionPosition.findMany.mockResolvedValue([
        { id: 'op-1', userId: 'user-1', marketId: 'market-1', optionId: 'opt-a', label: 'Haaland', totalShares: 10, totalCostKes: 100, avgPriceKes: 0.5, isSettled: false },
        { id: 'op-2', userId: 'user-2', marketId: 'market-1', optionId: 'opt-b', label: 'Mbappe', totalShares: 20, totalCostKes: 150, avgPriceKes: 0.5, isSettled: false },
      ]);
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', label: 'Haaland', poolKes: 700 },
        { optionId: 'opt-b', label: 'Mbappe', poolKes: 300 },
      ]);
      mockHttp.get.mockReturnValue(of(axiosResponse({ 'user-1': 'Alice', 'user-2': 'Bob' })));

      const result = await service.getMarketHolders('market-1');

      expect(result.marketType).toBe('MULTI');
      if (result.marketType !== 'MULTI') throw new Error('expected MULTI');

      const haaland = result.options.find((o) => o.optionId === 'opt-a');
      const mbappe = result.options.find((o) => o.optionId === 'opt-b');
      // total pot = 1000, Haaland price = 700/1000 = 0.7 -> 10*10*0.7=70
      expect(haaland?.holders[0]).toMatchObject({ userId: 'user-1', displayName: 'Alice', currentValue: 70 });
      // Mbappe price = 300/1000 = 0.3 -> 20*10*0.3=60
      expect(mbappe?.holders[0]).toMatchObject({ userId: 'user-2', displayName: 'Bob', currentValue: 60 });
    });

    it('returns empty yes/no arrays for a binary market with no open positions', async () => {
      mockPrisma.optionPool.count.mockResolvedValue(0);
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool());

      const result = await service.getMarketHolders('market-1');
      if (result.marketType !== 'BINARY') throw new Error('expected BINARY');
      expect(result.yes).toEqual([]);
      expect(result.no).toEqual([]);
    });
  });

  // ── getMarketOptionPositions ────────────────────────────────────────────────

  describe('getMarketOptionPositions', () => {
    const makeOptionPosition = (overrides = {}) => ({
      id: 'opos-1',
      userId: 'user-1',
      marketId: 'market-1',
      optionId: 'opt-a',
      label: 'Manchester City',
      totalShares: 100,
      totalCostKes: 1000,
      avgPriceKes: 0.5,
      isSettled: false,
      payoutKes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });

    it('prices each held option at its live share of the pool', async () => {
      mockPrisma.optionPosition.findMany.mockResolvedValue([makeOptionPosition()]);
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', poolKes: 3000 },
        { optionId: 'opt-b', poolKes: 1000 },
      ]);

      const result = await service.getMarketOptionPositions('user-1', 'market-1');
      expect(result).toEqual([
        expect.objectContaining({
          optionId: 'opt-a',
          label: 'Manchester City',
          sharesHeld: 100,
          costKes: 1000,
          currentPrice: 0.75,
          currentValue: 750,
          unrealizedPnl: -250,
        }),
      ]);
    });

    it('returns one row per option when the user backed more than one runner', async () => {
      mockPrisma.optionPosition.findMany.mockResolvedValue([
        makeOptionPosition({ optionId: 'opt-a', label: 'A' }),
        makeOptionPosition({ id: 'opos-2', optionId: 'opt-b', label: 'B' }),
      ]);
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', poolKes: 1000 },
        { optionId: 'opt-b', poolKes: 1000 },
      ]);

      const result = await service.getMarketOptionPositions('user-1', 'market-1');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.optionId)).toEqual(['opt-a', 'opt-b']);
    });

    it('returns empty array when the user holds no options in this market', async () => {
      mockPrisma.optionPosition.findMany.mockResolvedValue([]);

      const result = await service.getMarketOptionPositions('user-1', 'market-1');
      expect(result).toEqual([]);
      expect(mockPrisma.optionPool.findMany).not.toHaveBeenCalled();
    });
  });

  // ── getMarketTrades ─────────────────────────────────────────────────────────

  describe('getMarketTrades', () => {
    it('returns anonymized public trade list for a binary market', async () => {
      mockPrisma.optionPool.count.mockResolvedValue(0);
      mockPrisma.trade.findMany.mockResolvedValue([
        { outcome: 'YES', amountKes: 100, pricePerShare: 0.6, createdAt: new Date() },
      ]);
      mockPrisma.trade.count.mockResolvedValue(1);

      const result = await service.getMarketTrades('market-1');
      expect(result.data[0]).not.toHaveProperty('userId');
      expect(mockPrisma.optionTrade.findMany).not.toHaveBeenCalled();
    });

    it('returns anonymized option trades for a MULTI market', async () => {
      mockPrisma.optionPool.count.mockResolvedValue(3);
      mockPrisma.optionTrade.findMany.mockResolvedValue([
        { label: 'Manchester City', amountKes: 100, pricePerShare: 0.6, createdAt: new Date() },
      ]);
      mockPrisma.optionTrade.count.mockResolvedValue(1);

      const result = await service.getMarketTrades('market-1');
      expect(result.data[0]).toMatchObject({ label: 'Manchester City' });
      expect(result.data[0]).not.toHaveProperty('userId');
      expect(mockPrisma.trade.findMany).not.toHaveBeenCalled();
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

    it('fans out a settlement message to losers too, not just winners — previously they got silence', async () => {
      mockPrisma.position.findMany
        .mockResolvedValueOnce([makePosition({ userId: 'winner-1', totalShares: 100 })]) // winning side
        .mockResolvedValueOnce([makePosition({ userId: 'loser-1', outcome: 'NO', totalShares: 50 })]); // losing side
      mockPrisma.marketPool.findUnique.mockResolvedValue(makePool({ yesShares: 100 }));
      mockPrisma.settlement.upsert.mockResolvedValue({});
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.position.updateMany.mockResolvedValue({ count: 1 });

      await service.settleMarket(payload as any);

      expect(mockKafka.publishBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ payload: expect.objectContaining({ userId: 'loser-1', outcome: 'NO', payoutKes: 0 }) }),
        ]),
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

  // ── MULTI markets (pick-a-winner) ───────────────────────────────────────────

  describe('settleOptionMarket', () => {
    it('pays the whole pot net of rake to the winning option holders', async () => {
      // Pot is 2000 + 2000 + 1500 = 5500 across three runners, 4% rake.
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', label: 'A', poolKes: 2000, rake: 0.04 },
        { optionId: 'opt-b', label: 'B', poolKes: 2000, rake: 0.04 },
        { optionId: 'opt-c', label: 'C', poolKes: 1500, rake: 0.04 },
      ]);
      // One winner holding every winning share, so they take the full payout.
      mockPrisma.optionPosition.findMany.mockResolvedValue([
        { id: 'pos-1', userId: 'user-1', totalShares: 50 },
      ]);

      await service.settleOptionMarket('market-1', 'opt-c');

      // calcPayoutPerShare is mocked to 96/share at module scope, so this
      // asserts the wiring: the whole pot (not just the winning option's
      // pool) is passed in, and payout = shares * rate.
      const { calcPayoutPerShare } = jest.requireMock('@org/utils');
      expect(calcPayoutPerShare).toHaveBeenCalledWith(5500, 0.04, 50);
      expect(mockPrisma.optionPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pos-1' },
          data: { isSettled: true, payoutKes: 50 * 96 },
        }),
      );
    });

    it('settles losing positions with a zero payout', async () => {
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', label: 'A', poolKes: 1000, rake: 0.04 },
        { optionId: 'opt-b', label: 'B', poolKes: 1000, rake: 0.04 },
      ]);
      mockPrisma.optionPosition.findMany
        .mockResolvedValueOnce([{ id: 'pos-1', userId: 'user-1', totalShares: 10 }]) // winners
        .mockResolvedValueOnce([{ id: 'pos-2', userId: 'user-2', totalShares: 5, label: 'B' }]); // losers

      await service.settleOptionMarket('market-1', 'opt-a');

      expect(mockPrisma.optionPosition.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ optionId: { not: 'opt-a' }, isSettled: false }),
          data: { isSettled: true, payoutKes: 0 },
        }),
      );
    });

    it('fans out TRADING_MARKET_SETTLED to losing positions too — previously only winners were published, so a losing MULTI position never learned the market had resolved', async () => {
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', label: 'A', poolKes: 1000, rake: 0.04 },
        { optionId: 'opt-b', label: 'B', poolKes: 1000, rake: 0.04 },
      ]);
      mockPrisma.optionPosition.findMany
        .mockResolvedValueOnce([{ id: 'pos-1', userId: 'user-1', totalShares: 10 }]) // winners
        .mockResolvedValueOnce([{ id: 'pos-2', userId: 'user-2', totalShares: 5, label: 'B' }]); // losers

      await service.settleOptionMarket('market-1', 'opt-a');

      expect(mockKafka.publishBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ userId: 'user-2', payoutKes: 0, outcome: 'B' }),
          }),
        ]),
      );
    });

    it('publishes the real market title, not the raw marketId — previously every MULTI settlement notification showed the id string instead of a readable title', async () => {
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', label: 'A', poolKes: 1000, rake: 0.04 },
        { optionId: 'opt-b', label: 'B', poolKes: 1000, rake: 0.04 },
      ]);
      mockPrisma.optionPosition.findMany
        .mockResolvedValueOnce([{ id: 'pos-1', userId: 'user-1', totalShares: 10 }])
        .mockResolvedValueOnce([]);

      await service.settleOptionMarket('market-1', 'opt-a', 'Who wins the Ballon d\'Or?');

      expect(mockKafka.publishBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ marketTitle: 'Who wins the Ballon d\'Or?' }),
          }),
        ]),
      );
    });

    it('falls back to marketId when no title is passed', async () => {
      mockPrisma.optionPool.findMany.mockResolvedValue([
        { optionId: 'opt-a', label: 'A', poolKes: 1000, rake: 0.04 },
        { optionId: 'opt-b', label: 'B', poolKes: 1000, rake: 0.04 },
      ]);
      mockPrisma.optionPosition.findMany
        .mockResolvedValueOnce([{ id: 'pos-1', userId: 'user-1', totalShares: 10 }])
        .mockResolvedValueOnce([]);

      await service.settleOptionMarket('market-1', 'opt-a');

      expect(mockKafka.publishBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ payload: expect.objectContaining({ marketTitle: 'market-1' }) }),
        ]),
      );
    });
  });
});