import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  tradeEvent: {
    upsert: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  settlementEvent: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  },
  marketEarnings: {
    upsert: jest.fn(),
    aggregate: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
  leaderboardEntry: {
    findMany: jest.fn(),
    count: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  marketVolume: {
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockKafka = {
  subscribe: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockHttp = { get: jest.fn() };
const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? 'http://localhost:3002'),
};

function axiosOk<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KafkaService, useValue: mockKafka },
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  // ── handleTradeConfirmed (private, tested via onModuleInit subscriber) ────────

  describe('handleTradeConfirmed (via direct call)', () => {
    const tradePayload = {
      tradeId: 'trade-1',
      userId: 'user-1',
      marketId: 'market-1',
      outcome: 'YES',
      amountKes: 500,
      pricePerShare: 0.6,
    };

    it('upserts TradeEvent with idempotency on tradeId', async () => {
      mockPrisma.tradeEvent.upsert.mockResolvedValue({});

      // Access private method via any cast
      await (service as any).handleTradeConfirmed(tradePayload);

      expect(mockPrisma.tradeEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tradeId: 'trade-1' },
          create: expect.objectContaining({
            tradeId: 'trade-1',
            userId: 'user-1',
            marketId: 'market-1',
            outcome: 'YES',
            amountKes: 500,
          }),
          update: {},
        }),
      );
    });

    it('does not throw when upsert fails (error swallowed)', async () => {
      mockPrisma.tradeEvent.upsert.mockRejectedValue(new Error('DB error'));
      await expect((service as any).handleTradeConfirmed(tradePayload)).resolves.toBeUndefined();
    });
  });

  // ── handleMarketSettled ─────────────────────────────────────────────────────

  describe('handleMarketSettled (via direct call)', () => {
    const settledPayload = {
      marketId: 'market-1',
      marketTitle: 'Test Market',
      winningOutcome: 'YES',
      userId: 'user-1',
      outcome: 'YES',
      payoutKes: 960,
      sharesHeld: 100,
    };

    it('records a SettlementEvent with cost derived from TradeEvent — previously this was only logged, never stored', async () => {
      mockPrisma.tradeEvent.aggregate.mockResolvedValue({ _sum: { amountKes: 500 } });
      mockPrisma.settlementEvent.upsert.mockResolvedValue({});

      await (service as any).handleMarketSettled(settledPayload);

      expect(mockPrisma.settlementEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_marketId: { userId: 'user-1', marketId: 'market-1' } },
          create: expect.objectContaining({
            userId: 'user-1',
            marketId: 'market-1',
            won: true,
            payoutKes: 960,
            costKes: 500,
          }),
        }),
      );
    });

    it('marks won=false when the user\'s outcome did not match the winning one', async () => {
      mockPrisma.tradeEvent.aggregate.mockResolvedValue({ _sum: { amountKes: 500 } });
      mockPrisma.settlementEvent.upsert.mockResolvedValue({});

      await (service as any).handleMarketSettled({ ...settledPayload, outcome: 'NO', payoutKes: 0 });

      expect(mockPrisma.settlementEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ won: false, payoutKes: 0 }) }),
      );
    });

    it('does not throw when the upsert fails', async () => {
      mockPrisma.tradeEvent.aggregate.mockResolvedValue({ _sum: { amountKes: 500 } });
      mockPrisma.settlementEvent.upsert.mockRejectedValue(new Error('DB error'));
      await expect((service as any).handleMarketSettled(settledPayload)).resolves.toBeUndefined();
    });
  });

  // ── handleMarketResolved ────────────────────────────────────────────────────

  describe('handleMarketResolved (via direct call)', () => {
    const resolvedPayload = {
      marketId: 'market-1',
      marketTitle: 'Test Market',
      outcome: 'YES',
      totalPoolKes: 10000,
      rake: 0.04,
      resolvedAt: '2026-08-05T00:00:00.000Z',
    };

    it('records MarketEarnings as totalPoolKes * rake, independent of how the pot was staked', async () => {
      mockPrisma.marketEarnings.upsert.mockResolvedValue({});

      await (service as any).handleMarketResolved(resolvedPayload);

      expect(mockPrisma.marketEarnings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { marketId: 'market-1' },
          create: expect.objectContaining({
            marketId: 'market-1',
            marketTitle: 'Test Market',
            totalPoolKes: 10000,
            rake: 0.04,
            earningsKes: 400,
          }),
        }),
      );
    });

    it('does not throw when the upsert fails', async () => {
      mockPrisma.marketEarnings.upsert.mockRejectedValue(new Error('DB error'));
      await expect((service as any).handleMarketResolved(resolvedPayload)).resolves.toBeUndefined();
    });
  });

  // ── getLeaderboard ──────────────────────────────────────────────────────────

  describe('getLeaderboard', () => {
    beforeEach(() => {
      mockHttp.get.mockReturnValue(of(axiosOk({ 'user-1': 'Alice' })));
    });

    it('computes profit and win rate live from trade/settlement records, ranked by pnl — previously this only read an hourly-cron cache that could be stale or missing a trader entirely', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'user-1', volume_kes: '1000', trade_count: '42' },
      ]);
      mockPrisma.settlementEvent.findMany.mockResolvedValue([
        { userId: 'user-1', won: true, payoutKes: 2600, costKes: 100 },
        { userId: 'user-1', won: false, payoutKes: 0, costKes: 50 },
      ]);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 1, 20);

      expect(result).toMatchObject({
        period: '2026-W23',
        category: 'OVERALL',
        data: [expect.objectContaining({
          rank: 1, userId: 'user-1', displayName: 'Alice',
          profitKes: 2450, tradeCount: 42, winRate: 0.5,
        })],
        total: 1,
      });
    });

    it('ranks by pnl descending regardless of trade_events row order', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'user-lo', volume_kes: '100', trade_count: '1' },
        { user_id: 'user-hi', volume_kes: '100', trade_count: '1' },
      ]);
      mockPrisma.settlementEvent.findMany.mockResolvedValue([
        { userId: 'user-lo', won: false, payoutKes: 0, costKes: 100 },
        { userId: 'user-hi', won: true, payoutKes: 500, costKes: 100 },
      ]);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 1, 20);

      expect(result.data.map((e) => e.userId)).toEqual(['user-hi', 'user-lo']);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[1].rank).toBe(2);
    });

    it('resolves a friendly period name ("weekly") to the current ISO-week window — previously the literal string never matched a stored row', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.settlementEvent.findMany.mockResolvedValue([]);

      await service.getLeaderboard('weekly', 'OVERALL', 1, 10);

      expect(mockPrisma.settlementEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ settledAt: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }) }),
        }),
      );
    });

    it('paginates the ranked results', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'a', volume_kes: '100', trade_count: '1' },
        { user_id: 'b', volume_kes: '100', trade_count: '1' },
        { user_id: 'c', volume_kes: '100', trade_count: '1' },
      ]);
      mockPrisma.settlementEvent.findMany.mockResolvedValue([
        { userId: 'a', won: true, payoutKes: 300, costKes: 100 },
        { userId: 'b', won: true, payoutKes: 200, costKes: 100 },
        { userId: 'c', won: true, payoutKes: 150, costKes: 100 },
      ]);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 2, 1);

      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ userId: 'b', rank: 2 });
    });

    it('falls back to an empty displayName map when user-service is unreachable, rather than failing the whole request', async () => {
      mockHttp.get.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'user-1', volume_kes: '100', trade_count: '1' },
      ]);
      mockPrisma.settlementEvent.findMany.mockResolvedValue([
        { userId: 'user-1', won: true, payoutKes: 100, costKes: 0 },
      ]);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 1, 10);
      expect(result.data[0].displayName).toBe('Trader');
    });

    it('returns an empty leaderboard when no one has traded in the period', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.settlementEvent.findMany.mockResolvedValue([]);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 1, 20);
      expect(result).toMatchObject({ data: [], total: 0 });
    });
  });

  // ── getMarketStats ──────────────────────────────────────────────────────────

  describe('getMarketStats', () => {
    // Shape follows api.html: a single summary object, not a period array.
    // Computed from TradeEvent so a freshly traded market reports real numbers
    // instead of zeros until the MarketVolume rollup cron has run.
    it('summarises volume, trade count and unique traders', async () => {
      mockPrisma.tradeEvent.aggregate
        .mockResolvedValueOnce({ _sum: { amountKes: 50000 }, _count: { _all: 150 } })
        .mockResolvedValueOnce({ _sum: { amountKes: 1200 } })
        .mockResolvedValueOnce({ _sum: { amountKes: 9000 } });
      mockPrisma.tradeEvent.findMany.mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);

      const result = await service.getMarketStats('market-1');

      expect(result).toEqual({
        marketId: 'market-1',
        dailyVolume: 1200,
        weeklyVolume: 9000,
        totalVolume: 50000,
        uniqueTraders: 2,
        tradeCount: 150,
      });
    });

    it('reports zeros for a market with no trades', async () => {
      mockPrisma.tradeEvent.aggregate.mockResolvedValue({
        _sum: { amountKes: null },
        _count: { _all: 0 },
      });
      mockPrisma.tradeEvent.findMany.mockResolvedValue([]);

      const result = await service.getMarketStats('market-1');

      expect(result).toMatchObject({
        totalVolume: 0,
        uniqueTraders: 0,
        tradeCount: 0,
      });
    });
  });

  // ── getPlatformOverview ─────────────────────────────────────────────────────

  describe('getPlatformOverview', () => {
    it('resolves marketTitle for each top market — previously topMarkets only had marketId, so the admin dashboard showed raw ids instead of names', async () => {
      mockPrisma.tradeEvent.aggregate
        .mockResolvedValueOnce({ _sum: { amountKes: 50000 }, _count: { _all: 100 } }) // lifetime
        .mockResolvedValueOnce({ _sum: { amountKes: 5000 }, _count: { _all: 10 } }); // recent
      mockPrisma.tradeEvent.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.tradeEvent.groupBy.mockResolvedValue([
        { marketId: 'market-1', _sum: { amountKes: 30000 }, _count: { _all: 60 } },
        { marketId: 'market-2', _sum: { amountKes: 20000 }, _count: { _all: 40 } },
      ]);
      mockHttp.get.mockReturnValue(of(axiosOk([
        { id: 'market-1', title: 'Will BTC hit 100k?' },
        { id: 'market-2', title: "Who wins the Ballon d'Or?" },
      ])));

      const result = await service.getPlatformOverview(30);

      expect(mockHttp.get).toHaveBeenCalledWith(
        expect.stringContaining('/markets/batch'),
        expect.objectContaining({ params: { ids: 'market-1,market-2' } }),
      );
      expect(result.topMarkets).toEqual([
        { marketId: 'market-1', marketTitle: 'Will BTC hit 100k?', volumeKes: 30000, tradeCount: 60 },
        { marketId: 'market-2', marketTitle: "Who wins the Ballon d'Or?", volumeKes: 20000, tradeCount: 40 },
      ]);
    });

    it('falls back to the raw marketId when market-service is unreachable', async () => {
      mockPrisma.tradeEvent.aggregate
        .mockResolvedValueOnce({ _sum: { amountKes: 0 }, _count: { _all: 0 } })
        .mockResolvedValueOnce({ _sum: { amountKes: 0 }, _count: { _all: 0 } });
      mockPrisma.tradeEvent.findMany.mockResolvedValue([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.tradeEvent.groupBy.mockResolvedValue([
        { marketId: 'market-1', _sum: { amountKes: 100 }, _count: { _all: 1 } },
      ]);
      mockHttp.get.mockReturnValue(throwError(() => new Error('Connection refused')));

      const result = await service.getPlatformOverview(30);

      expect(result.topMarkets[0]).toMatchObject({ marketId: 'market-1', marketTitle: 'market-1' });
    });

    it('does not call market-service when there are no top markets', async () => {
      mockPrisma.tradeEvent.aggregate
        .mockResolvedValueOnce({ _sum: { amountKes: 0 }, _count: { _all: 0 } })
        .mockResolvedValueOnce({ _sum: { amountKes: 0 }, _count: { _all: 0 } });
      mockPrisma.tradeEvent.findMany.mockResolvedValue([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.tradeEvent.groupBy.mockResolvedValue([]);

      const result = await service.getPlatformOverview(30);

      expect(mockHttp.get).not.toHaveBeenCalled();
      expect(result.topMarkets).toEqual([]);
    });
  });

  // ── getUserStats ────────────────────────────────────────────────────────────

  describe('getUserStats', () => {
    it('computes real PnL and win rate from SettlementEvent — previously these were hardcoded to 0', async () => {
      mockPrisma.tradeEvent.aggregate.mockResolvedValue({ _sum: { amountKes: 15000 }, _count: { _all: 30 } });
      mockPrisma.settlementEvent.findMany.mockResolvedValue([
        { won: true, payoutKes: 1000, costKes: 400 },
        { won: false, payoutKes: 0, costKes: 300 },
        { won: true, payoutKes: 500, costKes: 200 },
      ]);

      const result = await service.getUserStats('user-1');

      expect(result).toMatchObject({
        userId: 'user-1',
        totalVolumeKes: 15000,
        totalTrades: 30,
        totalPnlKes: 600, // (1000-400) + (0-300) + (500-200)
        winRate: 2 / 3,
      });
    });

    it('returns zeros and winRate 0 when there are no settlements yet (open positions only)', async () => {
      mockPrisma.tradeEvent.aggregate.mockResolvedValue({ _sum: { amountKes: 0 }, _count: { _all: 0 } });
      mockPrisma.settlementEvent.findMany.mockResolvedValue([]);

      const result = await service.getUserStats('user-1');
      expect(result).toMatchObject({ totalTrades: 0, totalPnlKes: 0, winRate: 0 });
    });
  });

  // ── getPayoutsOverview ──────────────────────────────────────────────────────

  describe('getPayoutsOverview', () => {
    it('sources platform earnings from MarketEarnings (totalPoolKes * rake), not staked-minus-paid-out — seed liquidity funds part of every payout without being a "loss"', async () => {
      mockPrisma.marketEarnings.aggregate.mockResolvedValue({ _sum: { earningsKes: 400 } });
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: 9600, costKes: 8000 } });
      mockPrisma.marketEarnings.count.mockResolvedValue(1);
      mockPrisma.marketEarnings.findMany.mockResolvedValue([
        {
          marketId: 'market-1',
          marketTitle: 'Test Market',
          totalPoolKes: 10000,
          rake: 0.04,
          earningsKes: 400,
          resolvedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([
        { market_id: 'market-1', staked_kes: '8000', payouts_kes: '9600', winner_count: 3n, loser_count: 5n },
      ]);

      const result = await service.getPayoutsOverview(1, 20);

      expect(result).toMatchObject({
        totalPayoutsKes: 9600,
        totalStakedKes: 8000,
        totalPlatformEarningsKes: 400,
        settledMarketCount: 1,
      });
      expect(result.markets.data[0]).toMatchObject({
        marketId: 'market-1',
        marketTitle: 'Test Market',
        stakedKes: 8000,
        payoutsKes: 9600,
        platformEarningsKes: 400,
        winnerCount: 3,
        loserCount: 5,
      });
    });

    it('returns zeros when nothing has settled yet', async () => {
      mockPrisma.marketEarnings.aggregate.mockResolvedValue({ _sum: { earningsKes: null } });
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: null, costKes: null } });
      mockPrisma.marketEarnings.count.mockResolvedValue(0);
      mockPrisma.marketEarnings.findMany.mockResolvedValue([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getPayoutsOverview(1, 20);

      expect(result).toMatchObject({
        totalPayoutsKes: 0,
        totalStakedKes: 0,
        totalPlatformEarningsKes: 0,
        settledMarketCount: 0,
      });
      expect(result.markets.data).toEqual([]);
    });

    it('defaults staked/payouts/winner/loser to 0 for a market with earnings but no settlement rows joined yet', async () => {
      mockPrisma.marketEarnings.aggregate.mockResolvedValue({ _sum: { earningsKes: 40 } });
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: null, costKes: null } });
      mockPrisma.marketEarnings.count.mockResolvedValue(1);
      mockPrisma.marketEarnings.findMany.mockResolvedValue([
        {
          marketId: 'market-2',
          marketTitle: 'Pending Join',
          totalPoolKes: 1000,
          rake: 0.04,
          earningsKes: 40,
          resolvedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getPayoutsOverview(1, 20);

      expect(result.markets.data[0]).toMatchObject({
        marketId: 'market-2',
        stakedKes: 0,
        payoutsKes: 0,
        platformEarningsKes: 40,
        winnerCount: 0,
        loserCount: 0,
      });
    });
  });

  // ── getUserSettlementsOverview ──────────────────────────────────────────────

  describe('getUserSettlementsOverview', () => {
    beforeEach(() => {
      mockHttp.get.mockReturnValue(of(axiosOk({ 'user-1': 'Alice', 'user-2': 'Bob' })));
    });

    it('rolls up winnings and losses per user, ranked by net P&L by default — nothing previously answered "how is user X doing" across all traders', async () => {
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: 3000, costKes: 2500 } });
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          user_id: 'user-1', wagered_kes: '1000', won_kes: '2600',
          win_count: 3n, loss_count: 1n, last_settled_at: new Date('2026-08-01T00:00:00.000Z'),
        },
        {
          user_id: 'user-2', wagered_kes: '1500', won_kes: '400',
          win_count: 1n, loss_count: 4n, last_settled_at: new Date('2026-08-02T00:00:00.000Z'),
        },
      ]);

      const result = await service.getUserSettlementsOverview(1, 20);

      expect(result).toMatchObject({
        totalWageredKes: 2500,
        totalWonKes: 3000,
        netUserLossKes: -500,
        settledUserCount: 2,
      });
      // user-1 net +1600 ranks above user-2 net -1100, even though user-2
      // settled more recently and wagered more.
      expect(result.users.data[0]).toMatchObject({
        userId: 'user-1', displayName: 'Alice', wageredKes: 1000, wonKes: 2600,
        netPnlKes: 1600, winCount: 3, lossCount: 1, winRate: 0.75,
      });
      expect(result.users.data[1]).toMatchObject({
        userId: 'user-2', displayName: 'Bob', netPnlKes: -1100, winRate: 0.2,
      });
    });

    it('ranks by total wagered instead when sort=wagered', async () => {
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: 3000, costKes: 2500 } });
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'user-1', wagered_kes: '1000', won_kes: '2600', win_count: 3n, loss_count: 1n, last_settled_at: new Date() },
        { user_id: 'user-2', wagered_kes: '1500', won_kes: '400', win_count: 1n, loss_count: 4n, last_settled_at: new Date() },
      ]);

      const result = await service.getUserSettlementsOverview(1, 20, 'wagered');

      expect(result.users.data.map((u) => u.userId)).toEqual(['user-2', 'user-1']);
    });

    it('paginates the ranked results', async () => {
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: 0, costKes: 0 } });
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'a', wagered_kes: '100', won_kes: '300', win_count: 1n, loss_count: 0n, last_settled_at: new Date() },
        { user_id: 'b', wagered_kes: '100', won_kes: '200', win_count: 1n, loss_count: 0n, last_settled_at: new Date() },
        { user_id: 'c', wagered_kes: '100', won_kes: '150', win_count: 1n, loss_count: 0n, last_settled_at: new Date() },
      ]);

      const result = await service.getUserSettlementsOverview(2, 1);

      expect(result.settledUserCount).toBe(3);
      expect(result.users.total).toBe(3);
      expect(result.users.data).toHaveLength(1);
      expect(result.users.data[0].userId).toBe('b');
    });

    it('gives winRate 0 for a user with only unsettled activity, not a divide-by-zero crash', async () => {
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: 0, costKes: 100 } });
      mockPrisma.$queryRaw.mockResolvedValue([
        { user_id: 'user-1', wagered_kes: '100', won_kes: '0', win_count: 0n, loss_count: 0n, last_settled_at: new Date() },
      ]);

      const result = await service.getUserSettlementsOverview(1, 20);
      expect(result.users.data[0].winRate).toBe(0);
    });

    it('returns zeros and no rows when nothing has settled yet', async () => {
      mockPrisma.settlementEvent.aggregate.mockResolvedValue({ _sum: { payoutKes: null, costKes: null } });
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getUserSettlementsOverview(1, 20);

      expect(result).toMatchObject({ totalWageredKes: 0, totalWonKes: 0, netUserLossKes: 0, settledUserCount: 0 });
      expect(result.users.data).toEqual([]);
    });
  });

  // ── computeLeaderboard ──────────────────────────────────────────────────────

  describe('computeLeaderboard', () => {
    beforeEach(() => {
      // Raw leaderboard aggregation
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { user_id: 'user-1', volume_kes: '5000', trade_count: '10' },
          { user_id: 'user-2', volume_kes: '3000', trade_count: '6' },
        ])
        // Market volume aggregation
        .mockResolvedValueOnce([
          { market_id: 'market-1', volume_kes: '8000', trade_count: '16' },
        ]);

      mockPrisma.settlementEvent.findMany.mockResolvedValue([]);
      mockPrisma.leaderboardEntry.upsert.mockResolvedValue({});
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([
        { id: 'entry-1' },
        { id: 'entry-2' },
      ]);
      mockPrisma.leaderboardEntry.update.mockResolvedValue({});
      mockPrisma.marketVolume.upsert.mockResolvedValue({});
    });

    it('upserts leaderboard entries for each user', async () => {
      await service.computeLeaderboard('2026-W23');

      expect(mockPrisma.leaderboardEntry.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.leaderboardEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId_period_category: expect.objectContaining({ userId: 'user-1' }) }),
        }),
      );
    });

    it('computes real pnlKes and winRate per user from settlements in the period window — previously both were hardcoded to 0', async () => {
      mockPrisma.settlementEvent.findMany.mockResolvedValue([
        { userId: 'user-1', won: true, payoutKes: 1000, costKes: 400 },
        { userId: 'user-1', won: false, payoutKes: 0, costKes: 100 },
        { userId: 'user-2', won: true, payoutKes: 300, costKes: 200 },
      ]);

      await service.computeLeaderboard('2026-W23');

      expect(mockPrisma.leaderboardEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ userId: 'user-1', pnlKes: 500, winRate: 0.5 }),
        }),
      );
      expect(mockPrisma.leaderboardEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ userId: 'user-2', pnlKes: 100, winRate: 1 }),
        }),
      );
    });

    it('gives a user with trades but no settlements yet pnlKes 0 and winRate 0, not a crash', async () => {
      mockPrisma.settlementEvent.findMany.mockResolvedValue([]);

      await service.computeLeaderboard('2026-W23');

      expect(mockPrisma.leaderboardEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ userId: 'user-1', pnlKes: 0, winRate: 0 }),
        }),
      );
    });

    it('assigns sequential ranks after upsert', async () => {
      await service.computeLeaderboard('2026-W23');

      expect(mockPrisma.leaderboardEntry.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.leaderboardEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { rank: 1 } }),
      );
      expect(mockPrisma.leaderboardEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { rank: 2 } }),
      );
    });

    it('does nothing when no trade events found', async () => {
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await service.computeLeaderboard('2026-W23');
      expect(mockPrisma.leaderboardEntry.upsert).not.toHaveBeenCalled();
    });
  });
});
