import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { MarketService } from './market.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  market: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  priceSnapshot: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
};

const mockKafka = { publish: jest.fn().mockResolvedValue(undefined) };

jest.mock('@org/utils', () => ({
  calcYesPrice: jest.fn((yes: number, no: number) => yes / (yes + no) || 0.5),
  calcNoPrice: jest.fn((yes: number, no: number) => no / (yes + no) || 0.5),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeMarket = (overrides = {}) => ({
  id: 'market-1',
  slug: 'test-market',
  title: 'Will KES/USD exceed 130?',
  description: 'Test market',
  longDescription: null,
  category: 'forex',
  tags: [],
  imageUrl: null,
  sourceUrl: null,
  status: 'ACTIVE',
  poolYesKes: 1000,
  poolNoKes: 1000,
  totalVolume: 0,
  tradeCount: 0,
  rake: 0.04,
  seedYesKes: 1000,
  seedNoKes: 1000,
  openAt: new Date(),
  closeAt: new Date(Date.now() + 7 * 86400_000),
  resolveAt: new Date(Date.now() + 14 * 86400_000),
  resolvedOutcome: null,
  resolutionNote: null,
  resolvedBy: null,
  resolvedAt: null,
  createdBy: 'admin-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  version: 0,
  outcomes: [],
  feedConfig: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MarketService', () => {
  let service: MarketService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KafkaService, useValue: mockKafka },
      ],
    }).compile();

    service = module.get<MarketService>(MarketService);
  });

  // ── listMarkets ─────────────────────────────────────────────────────────────

  describe('listMarkets', () => {
    it('returns paginated markets with prices', async () => {
      mockPrisma.market.findMany.mockResolvedValue([makeMarket()]);
      mockPrisma.market.count.mockResolvedValue(1);

      const result = await service.listMarkets({});
      expect(result).toMatchObject({ data: expect.any(Array), meta: expect.objectContaining({ total: 1 }) });
      expect(result.data[0]).toHaveProperty('yesPrice');
      expect(result.data[0]).toHaveProperty('noPrice');
    });

    it('defaults to ACTIVE markets when no status filter', async () => {
      mockPrisma.market.findMany.mockResolvedValue([]);
      mockPrisma.market.count.mockResolvedValue(0);

      await service.listMarkets({});
      expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
    });

    it('respects status filter', async () => {
      mockPrisma.market.findMany.mockResolvedValue([]);
      mockPrisma.market.count.mockResolvedValue(0);

      await service.listMarkets({ status: 'RESOLVED' });
      expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'RESOLVED' }) }),
      );
    });

    it('caps limit at 50', async () => {
      mockPrisma.market.findMany.mockResolvedValue([]);
      mockPrisma.market.count.mockResolvedValue(0);

      await service.listMarkets({ limit: 200 });
      expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it('applies search filter with case-insensitive OR', async () => {
      mockPrisma.market.findMany.mockResolvedValue([]);
      mockPrisma.market.count.mockResolvedValue(0);

      await service.listMarkets({ search: 'KES' });
      const call = mockPrisma.market.findMany.mock.calls[0][0];
      expect(call.where).toHaveProperty('OR');
    });
  });

  // ── getMarket ───────────────────────────────────────────────────────────────

  describe('getMarket', () => {
    it('finds market by id and returns with prices', async () => {
      mockPrisma.market.findFirst.mockResolvedValue(makeMarket());
      const result = await service.getMarket('market-1');
      expect(result).toMatchObject({ id: 'market-1', yesPrice: expect.any(Number) });
    });

    it('finds market by slug', async () => {
      mockPrisma.market.findFirst.mockResolvedValue(makeMarket({ slug: 'test-market' }));
      const result = await service.getMarket('test-market');
      expect(result.slug).toBe('test-market');
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.market.findFirst.mockResolvedValue(null);
      await expect(service.getMarket('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── getPriceHistory ─────────────────────────────────────────────────────────

  describe('getPriceHistory', () => {
    it('returns snapshots within hours window', async () => {
      const snapshots = [
        { yesPrice: 0.5, noPrice: 0.5, volume: 100, snapshotAt: new Date() },
      ];
      mockPrisma.priceSnapshot.findMany.mockResolvedValue(snapshots);

      const result = await service.getPriceHistory('market-1', 24);
      expect(result).toEqual(snapshots);
      expect(mockPrisma.priceSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ marketId: 'market-1' }) }),
      );
    });
  });

  // ── getCategories ───────────────────────────────────────────────────────────

  describe('getCategories', () => {
    it('returns category list with counts', async () => {
      mockPrisma.market.groupBy.mockResolvedValue([
        { category: 'sports', _count: { id: 5 } },
        { category: 'forex', _count: { id: 3 } },
      ]);

      const result = await service.getCategories();
      expect(result).toEqual([
        { category: 'sports', count: 5 },
        { category: 'forex', count: 3 },
      ]);
    });
  });

  // ── createMarket ────────────────────────────────────────────────────────────

  describe('createMarket', () => {
    const dto = {
      title: 'Will Kenya win AFCON 2025?',
      description: 'Test description',
      category: 'sports',
      openAt: new Date(Date.now() + 1000).toISOString(),
      closeAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      resolvesAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
    };

    it('creates market with DRAFT status and publishes Kafka event', async () => {
      mockPrisma.market.create.mockResolvedValue(makeMarket({ status: 'DRAFT', title: dto.title }));

      const result = await service.createMarket(dto as any, 'admin-1');

      expect(mockPrisma.market.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DRAFT', title: dto.title }),
        }),
      );
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('market.created'),
        expect.objectContaining({ marketId: 'market-1' }),
      );
      expect(result.status).toBe('DRAFT');
    });

    it('generates a slug from the title', async () => {
      mockPrisma.market.create.mockResolvedValue(makeMarket({ status: 'DRAFT' }));
      await service.createMarket(dto as any, 'admin-1');

      const createCall = mockPrisma.market.create.mock.calls[0][0];
      expect(createCall.data.slug).toBeDefined();
      expect(typeof createCall.data.slug).toBe('string');
    });
  });

  // ── activateMarket ──────────────────────────────────────────────────────────

  describe('activateMarket', () => {
    it('transitions DRAFT → ACTIVE and publishes event', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'DRAFT' }));
      mockPrisma.market.update.mockResolvedValue(makeMarket({ status: 'ACTIVE' }));

      const result = await service.activateMarket('market-1');
      expect(result.status).toBe('ACTIVE');
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('market.activated'),
        expect.objectContaining({ marketId: 'market-1' }),
      );
    });

    it('throws BadRequestException when market is not DRAFT', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'ACTIVE' }));
      await expect(service.activateMarket('market-1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for unknown market', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(null);
      await expect(service.activateMarket('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ── closeMarket ─────────────────────────────────────────────────────────────

  describe('closeMarket', () => {
    it('transitions ACTIVE → CLOSED', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'ACTIVE' }));
      mockPrisma.market.update.mockResolvedValue(makeMarket({ status: 'CLOSED' }));

      const result = await service.closeMarket('market-1');
      expect(result.status).toBe('CLOSED');
      expect(mockKafka.publish).toHaveBeenCalled();
    });

    it('throws BadRequestException when market is not ACTIVE', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'DRAFT' }));
      await expect(service.closeMarket('market-1')).rejects.toThrow(BadRequestException);
    });
  });

  // ── resolveMarket ───────────────────────────────────────────────────────────

  describe('resolveMarket', () => {
    it('resolves ACTIVE market with YES outcome', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'ACTIVE' }));
      mockPrisma.market.update.mockResolvedValue(makeMarket({ status: 'RESOLVED', resolvedOutcome: 'YES' }));

      const result = await service.resolveMarket('market-1', { outcome: 'YES' } as any, 'admin-1');
      expect(result.status).toBe('RESOLVED');
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('market.resolved'),
        expect.objectContaining({ marketId: 'market-1', outcome: 'YES' }),
      );
    });

    it('resolves CLOSED market with NO outcome', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'CLOSED' }));
      mockPrisma.market.update.mockResolvedValue(makeMarket({ status: 'RESOLVED', resolvedOutcome: 'NO' }));

      await service.resolveMarket('market-1', { outcome: 'NO' } as any, 'admin-1');
      expect(mockPrisma.market.update).toHaveBeenCalled();
    });

    it('throws BadRequestException when market is DRAFT', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'DRAFT' }));
      await expect(service.resolveMarket('market-1', { outcome: 'YES' } as any, 'admin-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when market is already RESOLVED', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'RESOLVED' }));
      await expect(service.resolveMarket('market-1', { outcome: 'YES' } as any, 'admin-1'))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── cancelMarket ────────────────────────────────────────────────────────────

  describe('cancelMarket', () => {
    it('cancels ACTIVE market and publishes event', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'ACTIVE' }));
      mockPrisma.market.update.mockResolvedValue(makeMarket({ status: 'CANCELLED' }));

      await service.cancelMarket('market-1');
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('market.cancelled'),
        expect.objectContaining({ marketId: 'market-1' }),
      );
    });

    it('throws BadRequestException when market is already RESOLVED', async () => {
      mockPrisma.market.findUnique.mockResolvedValue(makeMarket({ status: 'RESOLVED' }));
      await expect(service.cancelMarket('market-1')).rejects.toThrow(BadRequestException);
    });
  });

  // ── updatePoolStats ─────────────────────────────────────────────────────────

  describe('updatePoolStats', () => {
    it('updates pool and records price snapshot', async () => {
      mockPrisma.market.update.mockResolvedValue(makeMarket({ poolYesKes: 1500, poolNoKes: 1000 }));
      mockPrisma.priceSnapshot.create.mockResolvedValue({});

      await service.updatePoolStats('market-1', 1500, 1000, 500);
      expect(mockPrisma.market.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ poolYesKes: 1500, poolNoKes: 1000 }),
        }),
      );
      expect(mockPrisma.priceSnapshot.create).toHaveBeenCalled();
    });
  });
});
