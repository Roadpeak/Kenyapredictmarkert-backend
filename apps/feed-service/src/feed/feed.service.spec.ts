import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { FeedService } from './feed.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockKafka = {
  subscribe: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockHttp = { get: jest.fn() };

const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? 'http://localhost:3003'),
};

const mockPrisma = {
  feedItem: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
};

function axiosOk<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

const makeFeedRow = (overrides = {}) => ({
  id: 'feed-1',
  userId: 'user-1',
  type: 'TRADE_CONFIRMED',
  title: 'Trade Placed',
  body: 'You bought 10 YES shares',
  metadata: {},
  occurredAt: new Date(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FeedService', () => {
  let service: FeedService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedService,
        { provide: KafkaService, useValue: mockKafka },
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<FeedService>(FeedService);
  });

  // ── getUserFeed ─────────────────────────────────────────────────────────────

  describe('getUserFeed', () => {
    it('returns empty feed for user with no items, shaped as Paginated<ActivityItem>', async () => {
      mockPrisma.feedItem.findMany.mockResolvedValue([]);
      mockPrisma.feedItem.count.mockResolvedValue(0);

      const result = await service.getUserFeed('user-nobody', 1, 20);
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });

    it('reads from a real table now, not an in-memory Map — previously a service restart wiped every user\'s entire history', async () => {
      mockPrisma.feedItem.findMany.mockResolvedValue([
        makeFeedRow({ metadata: { marketId: 'market-1', outcome: 'YES', amountKes: 100 } }),
      ]);
      mockPrisma.feedItem.count.mockResolvedValue(1);

      const result = await service.getUserFeed('user-1', 1, 20);

      expect(mockPrisma.feedItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' }, orderBy: { occurredAt: 'desc' } }),
      );
      expect(result.data[0]).toMatchObject({
        type: 'TRADE_CONFIRMED',
        marketId: 'market-1',
        payload: expect.objectContaining({ outcome: 'YES', amountKes: 100 }),
      });
    });

    it('paginates via skip/take, not an in-process array slice', async () => {
      mockPrisma.feedItem.findMany.mockResolvedValue([]);
      mockPrisma.feedItem.count.mockResolvedValue(0);

      await service.getUserFeed('user-1', 3, 10);

      expect(mockPrisma.feedItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  // ── getDiscoveryFeed ────────────────────────────────────────────────────────

  describe('getDiscoveryFeed', () => {
    it('proxies to market-service with sort=volume', async () => {
      const marketData = { data: [], meta: { total: 0 } };
      mockHttp.get.mockReturnValue(of(axiosOk(marketData)));

      const result = await service.getDiscoveryFeed(1, 20);

      expect(mockHttp.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/markets'),
        expect.objectContaining({
          params: expect.objectContaining({ sort: 'volume', status: 'ACTIVE' }),
        }),
      );
      expect(result).toEqual(marketData);
    });

    it('returns empty result on market-service error', async () => {
      mockHttp.get.mockReturnValue(throwError(() => new Error('Connection refused')));

      const result = await service.getDiscoveryFeed(1, 10) as any;

      expect(result).toMatchObject({ data: [], meta: { total: 0 } });
    });
  });

  // ── onModuleInit — Kafka subscriber registration ────────────────────────────

  describe('onModuleInit', () => {
    it('registers Kafka consumers for all feed topics', async () => {
      await service.onModuleInit();

      const groups = (mockKafka.subscribe as jest.Mock).mock.calls.map((c) => c[0]);
      expect(groups).toContain('feed-trade-confirmed-group');
      expect(groups).toContain('feed-settlement-group');
      expect(groups).toContain('feed-deposit-group');
      expect(groups).toContain('feed-withdrawal-group');
      expect(groups).toContain('feed-market-resolved-group');
    });

    it('persists a trade-confirmed event to the feed table via the subscriber callback', async () => {
      let tradeCallback: ((_topic: string, payload: any) => Promise<void>) | null = null;

      (mockKafka.subscribe as jest.Mock).mockImplementation(
        (group: string, _topics: string[], callback: Function) => {
          if (group === 'feed-trade-confirmed-group') {
            tradeCallback = callback as any;
          }
          return Promise.resolve();
        },
      );

      await service.onModuleInit();
      expect(tradeCallback).not.toBeNull();

      mockPrisma.feedItem.create.mockResolvedValue({});
      await tradeCallback!('topic', {
        tradeId: 'trade-abc',
        userId: 'user-feed-test',
        marketId: 'market-1',
        marketTitle: 'Will it rain?',
        outcome: 'YES',
        sharesCount: 10,
        amountKes: 1000,
        pricePerShare: 0.6,
      });

      expect(mockPrisma.feedItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-feed-test',
            type: 'TRADE_CONFIRMED',
            metadata: expect.objectContaining({ marketId: 'market-1', outcome: 'YES', sharesCount: 10 }),
          }),
        }),
      );
    });

    it('does not throw when the write fails — a feed-persistence hiccup must not break the Kafka consumer', async () => {
      let tradeCallback: ((_topic: string, payload: any) => Promise<void>) | null = null;

      (mockKafka.subscribe as jest.Mock).mockImplementation(
        (group: string, _topics: string[], callback: Function) => {
          if (group === 'feed-trade-confirmed-group') {
            tradeCallback = callback as any;
          }
          return Promise.resolve();
        },
      );

      await service.onModuleInit();
      mockPrisma.feedItem.create.mockRejectedValue(new Error('DB error'));

      await expect(
        tradeCallback!('topic', {
          tradeId: 'trade-fail',
          userId: 'user-1',
          marketId: 'market-1',
          marketTitle: 'Test',
          outcome: 'YES',
          sharesCount: 1,
          amountKes: 100,
          pricePerShare: 0.6,
        }),
      ).resolves.toBeUndefined();
    });

    it('persists a market-settlement event with the won flag and payout', async () => {
      let settleCallback: ((_topic: string, payload: any) => Promise<void>) | null = null;

      (mockKafka.subscribe as jest.Mock).mockImplementation(
        (group: string, _topics: string[], callback: Function) => {
          if (group === 'feed-settlement-group') {
            settleCallback = callback as any;
          }
          return Promise.resolve();
        },
      );

      await service.onModuleInit();
      mockPrisma.feedItem.create.mockResolvedValue({});

      await settleCallback!('topic', {
        marketId: 'market-1',
        marketTitle: 'Test Market',
        winningOutcome: 'YES',
        userId: 'user-1',
        outcome: 'YES',
        payoutKes: 500,
        sharesHeld: 50,
      });

      expect(mockPrisma.feedItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'MARKET_SETTLED',
            title: 'You Won!',
            metadata: expect.objectContaining({ payoutKes: 500, won: true }),
          }),
        }),
      );
    });
  });
});
