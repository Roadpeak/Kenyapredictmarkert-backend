import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { FeedService, FeedItem } from './feed.service';
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

function axiosOk<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

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
      ],
    }).compile();

    service = module.get<FeedService>(FeedService);
  });

  // ── getUserFeed ─────────────────────────────────────────────────────────────

  describe('getUserFeed', () => {
    it('returns empty feed for user with no items, shaped as Paginated<ActivityItem>', () => {
      const result = service.getUserFeed('user-nobody', 1, 20);
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });

    it('returns correct page slice', () => {
      const result = service.getUserFeed('user-paged', 1, 3);
      expect(result).toMatchObject({ data: expect.any(Array), total: 0, page: 1, limit: 3 });
    });

    it('paginates correctly', () => {
      expect(service.getUserFeed('any', 1, 10)).toMatchObject({ page: 1, limit: 10 });
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

    it('adds trade event to user feed via subscriber callback', async () => {
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

      const feed = service.getUserFeed('user-feed-test', 1, 20);
      expect(feed.total).toBe(1);
      expect(feed.data[0]).toMatchObject({
        type: 'TRADE_CONFIRMED',
        marketId: 'market-1',
        payload: expect.objectContaining({ outcome: 'YES', sharesCount: 10, amountKes: 1000 }),
      });
    });

    it('caps feed at 50 items per user', async () => {
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

      // Add 55 items
      for (let i = 0; i < 55; i++) {
        await tradeCallback!('topic', {
          tradeId: `trade-cap-${i}`,
          userId: 'user-cap-test',
          marketId: 'market-1',
          marketTitle: 'Cap test',
          outcome: 'YES',
          sharesCount: 1,
          amountKes: 100,
          pricePerShare: 0.6,
        });
      }

      const feed = service.getUserFeed('user-cap-test', 1, 100);
      expect(feed.total).toBe(50);
    });

    it('most recent item appears first (unshift)', async () => {
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

      await tradeCallback!('topic', {
        tradeId: 'first-trade',
        userId: 'user-order-test',
        marketId: 'market-1',
        marketTitle: 'Order test',
        outcome: 'YES',
        sharesCount: 1,
        amountKes: 100,
        pricePerShare: 0.6,
      });

      await tradeCallback!('topic', {
        tradeId: 'second-trade',
        userId: 'user-order-test',
        marketId: 'market-1',
        marketTitle: 'Order test',
        outcome: 'NO',
        sharesCount: 2,
        amountKes: 200,
        pricePerShare: 0.4,
      });

      const feed = service.getUserFeed('user-order-test', 1, 20);
      expect(feed.data[0].payload).toMatchObject({ outcome: 'NO', amountKes: 200 });
      expect(feed.data[1].payload).toMatchObject({ outcome: 'YES', amountKes: 100 });
    });
  });
});
