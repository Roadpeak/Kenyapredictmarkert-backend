import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { calcYesPrice, calcNoPrice } from '@org/utils';
import { CreateMarketDto, ResolveMarketDto, MarketQueryDto } from './market.dto';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  // ─── List markets ─────────────────────────────────────────────────────────────

  async listMarkets(query: MarketQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 50);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.category) where.category = query.category;
    if (query.status && query.status !== 'all') where.status = query.status;
    else if (!query.status) where.status = 'ACTIVE';

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { tags: { has: query.search.toLowerCase() } },
      ];
    }

    let orderBy: any = { createdAt: 'desc' };
    if (query.sort === 'volume') orderBy = { totalVolume: 'desc' };
    if (query.sort === 'closing-soon') orderBy = { closeAt: 'asc' };
    if (query.sort === 'newest') orderBy = { createdAt: 'desc' };

    const [markets, total] = await Promise.all([
      this.prisma.market.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          slug: true,
          title: true,
          category: true,
          tags: true,
          imageUrl: true,
          status: true,
          poolYesKes: true,
          poolNoKes: true,
          totalVolume: true,
          tradeCount: true,
          closeAt: true,
          resolveAt: true,
          resolvedOutcome: true,
          createdAt: true,
        },
      }),
      this.prisma.market.count({ where }),
    ]);

    const marketsWithPrice = markets.map((m) => ({
      ...m,
      yesPrice: calcYesPrice(Number(m.poolYesKes), Number(m.poolNoKes)),
      noPrice: calcNoPrice(Number(m.poolYesKes), Number(m.poolNoKes)),
    }));

    return {
      data: marketsWithPrice,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Get single market ────────────────────────────────────────────────────────

  async getMarket(idOrSlug: string) {
    const market = await this.prisma.market.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: { outcomes: true, feedConfig: true },
    });
    if (!market) throw new NotFoundException(`Market not found: ${idOrSlug}`);

    return {
      ...market,
      yesPrice: calcYesPrice(Number(market.poolYesKes), Number(market.poolNoKes)),
      noPrice: calcNoPrice(Number(market.poolYesKes), Number(market.poolNoKes)),
    };
  }

  // ─── Price history ────────────────────────────────────────────────────────────

  async getPriceHistory(marketId: string, hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.prisma.priceSnapshot.findMany({
      where: { marketId, snapshotAt: { gte: since } },
      orderBy: { snapshotAt: 'asc' },
      select: { yesPrice: true, noPrice: true, volume: true, snapshotAt: true },
    });
  }

  // ─── Categories ───────────────────────────────────────────────────────────────

  async getCategories() {
    const results = await this.prisma.market.groupBy({
      by: ['category'],
      where: { status: 'ACTIVE' },
      _count: { id: true },
    });
    return results.map((r) => ({ category: r.category, count: r._count.id }));
  }

  // ─── Admin: Create market ─────────────────────────────────────────────────────

  async createMarket(dto: CreateMarketDto, adminId: string) {
    const slug = this.generateSlug(dto.title);

    const market = await this.prisma.market.create({
      data: {
        slug,
        title: dto.title,
        description: dto.description,
        longDescription: dto.longDescription,
        category: dto.category,
        tags: dto.tags ?? [],
        imageUrl: dto.imageUrl,
        sourceUrl: dto.sourceUrl,
        openAt: new Date(dto.openAt),
        closeAt: new Date(dto.closeAt),
        resolveAt: dto.resolveAt ? new Date(dto.resolveAt) : null,
        rake: dto.rake ?? 0.04,
        seedYesKes: dto.seedYesKes ?? 1000,
        seedNoKes: dto.seedNoKes ?? 1000,
        poolYesKes: dto.seedYesKes ?? 1000,
        poolNoKes: dto.seedNoKes ?? 1000,
        createdBy: adminId,
        status: 'DRAFT',
        outcomes: {
          create: [{ label: 'YES' }, { label: 'NO' }],
        },
      },
    });

    await this.kafka.publish(KAFKA_TOPICS.MARKET_CREATED, {
      marketId: market.id,
      title: market.title,
      category: market.category,
    });

    this.logger.log(`Market created: ${market.id} — "${market.title}"`);
    return market;
  }

  // ─── Admin: Activate market ───────────────────────────────────────────────────

  async activateMarket(marketId: string) {
    const market = await this.findMarketOrThrow(marketId);
    if (market.status !== 'DRAFT') {
      throw new BadRequestException(`Cannot activate market in status: ${market.status}`);
    }

    const updated = await this.prisma.market.update({
      where: { id: marketId },
      data: { status: 'ACTIVE' },
    });

    await this.kafka.publish(KAFKA_TOPICS.MARKET_ACTIVATED, {
      marketId,
      title: market.title,
      category: market.category,
      closeAt: market.closeAt.toISOString(),
    });

    return updated;
  }

  // ─── Admin: Close market ──────────────────────────────────────────────────────

  async closeMarket(marketId: string) {
    const market = await this.findMarketOrThrow(marketId);
    if (market.status !== 'ACTIVE') {
      throw new BadRequestException(`Cannot close market in status: ${market.status}`);
    }

    const updated = await this.prisma.market.update({
      where: { id: marketId },
      data: { status: 'CLOSED' },
    });

    await this.kafka.publish(KAFKA_TOPICS.MARKET_CLOSED, { marketId });
    return updated;
  }

  // ─── Admin: Resolve market ────────────────────────────────────────────────────

  async resolveMarket(marketId: string, dto: ResolveMarketDto, adminId: string) {
    const market = await this.findMarketOrThrow(marketId);
    if (!['ACTIVE', 'CLOSED'].includes(market.status)) {
      throw new BadRequestException(`Cannot resolve market in status: ${market.status}`);
    }

    const updated = await this.prisma.market.update({
      where: { id: marketId },
      data: {
        status: 'RESOLVED',
        resolvedOutcome: dto.outcome as any,
        resolutionNote: dto.note,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    });

    const totalPool = Number(market.poolYesKes) + Number(market.poolNoKes);

    await this.kafka.publish(KAFKA_TOPICS.MARKET_RESOLVED, {
      marketId,
      outcome: dto.outcome,
      totalPoolKes: totalPool,
      rake: Number(market.rake),
      resolvedAt: new Date().toISOString(),
    });

    this.logger.log(`Market resolved: ${marketId} → ${dto.outcome}`);
    return updated;
  }

  // ─── Admin: Cancel market ─────────────────────────────────────────────────────

  async cancelMarket(marketId: string) {
    const market = await this.findMarketOrThrow(marketId);
    if (market.status === 'RESOLVED') {
      throw new BadRequestException('Cannot cancel an already resolved market');
    }

    const updated = await this.prisma.market.update({
      where: { id: marketId },
      data: { status: 'CANCELLED' },
    });

    await this.kafka.publish(KAFKA_TOPICS.MARKET_CANCELLED, {
      marketId,
      cancelledAt: new Date().toISOString(),
    });

    return updated;
  }

  // ─── Called by trading-service after each trade ───────────────────────────────

  async updatePoolStats(
    marketId: string,
    poolYesKes: number,
    poolNoKes: number,
    volumeDelta: number,
  ) {
    const market = await this.prisma.market.update({
      where: { id: marketId },
      data: {
        poolYesKes,
        poolNoKes,
        totalVolume: { increment: volumeDelta },
        tradeCount: { increment: 1 },
      },
    });

    // Record price snapshot
    await this.prisma.priceSnapshot.create({
      data: {
        marketId,
        yesPrice: calcYesPrice(poolYesKes, poolNoKes),
        noPrice: calcNoPrice(poolYesKes, poolNoKes),
        volume: volumeDelta,
      },
    });

    return market;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private async findMarketOrThrow(id: string) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) throw new NotFoundException(`Market not found: ${id}`);
    return market;
  }

  private generateSlug(title: string): string {
    const base = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60);
    const suffix = Date.now().toString(36);
    return `${base}-${suffix}`;
  }
}
