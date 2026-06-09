import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  tradeEvent: {
    upsert: jest.fn(),
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

  // ── getLeaderboard ──────────────────────────────────────────────────────────

  describe('getLeaderboard', () => {
    const entry = {
      rank: 1,
      userId: 'user-1',
      pnlKes: { toNumber: () => 2500 } as any,
      volumeKes: { toNumber: () => 10000 } as any,
      tradeCount: 42,
    };

    it('returns paginated entries with numeric conversion', async () => {
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([{
        rank: 1, userId: 'user-1', pnlKes: 2500, volumeKes: 10000, tradeCount: 42,
      }]);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(1);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 1, 20);

      expect(result).toMatchObject({
        entries: [expect.objectContaining({ rank: 1, userId: 'user-1', tradeCount: 42 })],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('queries by period and category', async () => {
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([]);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(0);

      await service.getLeaderboard('2026-W23', 'SPORTS', 1, 10);

      expect(mockPrisma.leaderboardEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { period: '2026-W23', category: 'SPORTS' } }),
      );
    });

    it('calculates totalPages correctly', async () => {
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([]);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(25);

      const result = await service.getLeaderboard('2026-W23', 'OVERALL', 1, 10);
      expect(result.totalPages).toBe(3);
    });
  });

  // ── getMarketStats ──────────────────────────────────────────────────────────

  describe('getMarketStats', () => {
    it('returns volume and trade count for a market', async () => {
      mockPrisma.marketVolume.findMany.mockResolvedValue([
        { period: '2026-W23', volumeKes: 50000, tradeCount: 150, computedAt: new Date() },
      ]);

      const result = await service.getMarketStats('market-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        period: '2026-W23',
        volumeKes: 50000,
        tradeCount: 150,
      });
    });

    it('returns empty array when no volumes recorded', async () => {
      mockPrisma.marketVolume.findMany.mockResolvedValue([]);
      const result = await service.getMarketStats('market-1');
      expect(result).toEqual([]);
    });
  });

  // ── getUserStats ────────────────────────────────────────────────────────────

  describe('getUserStats', () => {
    it('returns stats from raw query with numeric coercion', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { total_volume_kes: '15000', total_trades: '30', total_pnl_kes: '2000', win_count: '18' },
      ]);

      const result = await service.getUserStats('user-1');

      expect(result).toMatchObject({
        userId: 'user-1',
        totalVolumeKes: 15000,
        totalTrades: 30,
        totalPnlKes: 2000,
        winRate: 0.6,
      });
    });

    it('returns zeros and winRate 0 when no trades', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { total_volume_kes: '0', total_trades: '0', total_pnl_kes: '0', win_count: '0' },
      ]);

      const result = await service.getUserStats('user-1');
      expect(result).toMatchObject({ totalTrades: 0, winRate: 0 });
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
