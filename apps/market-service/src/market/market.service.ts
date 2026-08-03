import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { calcYesPrice, calcNoPrice } from '@org/utils';
import {
  CreateMarketDto,
  ResolveMarketDto,
  MarketQueryDto,
  MARKET_CATEGORIES,
  CATEGORY_LABELS,
} from './market.dto';

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

    const marketsWithPrice = markets.map((m) =>
      this.toMarketResponse({
        ...m,
        yesPrice: calcYesPrice(Number(m.poolYesKes), Number(m.poolNoKes)),
        noPrice: calcNoPrice(Number(m.poolYesKes), Number(m.poolNoKes)),
      }),
    );

    return {
      data: marketsWithPrice,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Get single market ────────────────────────────────────────────────────────

  async getMarket(idOrSlug: string) {
    const market = await this.prisma.market.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        outcomes: true,
        feedConfig: true,
        options: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!market) throw new NotFoundException(`Market not found: ${idOrSlug}`);

    // Parimutuel price for a MULTI option is its share of the total pot —
    // the same formula the binary path uses, generalised to N runners.
    // BINARY markets have no options, so this collapses to an empty list.
    const options = market.options ?? [];
    const optionsTotal = options.reduce((sum, o) => sum + Number(o.poolKes), 0);

    return this.toMarketResponse({
      ...market,
      yesPrice: calcYesPrice(Number(market.poolYesKes), Number(market.poolNoKes)),
      noPrice: calcNoPrice(Number(market.poolYesKes), Number(market.poolNoKes)),
      options: options.map((o) => ({
        ...o,
        poolKes: Number(o.poolKes),
        totalShares: Number(o.totalShares),
        price: optionsTotal > 0 ? Number(o.poolKes) / optionsTotal : 1 / (options.length || 1),
      })),
    });
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
    const counts = new Map(results.map((r) => [r.category, r._count.id]));

    // Every valid category is returned, not just ones that already have active
    // markets — otherwise admins could never pick a category for its first
    // market. `slug`/`name`/`activeCount` is the shape clients consume.
    return MARKET_CATEGORIES.map((slug) => ({
      slug,
      name: CATEGORY_LABELS[slug] ?? slug,
      activeCount: counts.get(slug) ?? 0,
    }));
  }

  // ─── Admin: Create market ─────────────────────────────────────────────────────

  async createMarket(dto: CreateMarketDto, adminId: string) {
    const slug = this.generateSlug(dto.title);
    const marketType = dto.marketType ?? 'BINARY';

    if (marketType === 'MULTI') {
      if (!dto.options || dto.options.length < 2) {
        throw new BadRequestException(
          'A multi-outcome market needs at least 2 options',
        );
      }
      const labels = dto.options.map((o) => o.label.trim().toLowerCase());
      if (new Set(labels).size !== labels.length) {
        throw new BadRequestException('Option labels must be unique');
      }
    }

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
        marketType,
        // BINARY keeps its YES/NO outcome rows; MULTI carries its runners in
        // MarketOption instead, each seeded with its own starting pool.
        ...(marketType === 'BINARY'
          ? { outcomes: { create: [{ label: 'YES' as const }, { label: 'NO' as const }] } }
          : {
              options: {
                create: (dto.options ?? []).map((o, i) => ({
                  label: o.label.trim(),
                  imageUrl: o.imageUrl,
                  sortOrder: i,
                  seedKes: o.seedKes ?? 1000,
                  poolKes: o.seedKes ?? 1000,
                })),
              },
            }),
      },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
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

    const options = await this.prisma.marketOption.findMany({
      where: { marketId },
      orderBy: { sortOrder: 'asc' },
    });

    await this.kafka.publish(KAFKA_TOPICS.MARKET_ACTIVATED, {
      marketId,
      title: market.title,
      category: market.category,
      closeAt: market.closeAt.toISOString(),
      marketType: market.marketType,
      // trading-service seeds its pools from these on activation — without
      // them no pool exists and every trade on this market fails.
      seedYesKes: Number(market.seedYesKes),
      seedNoKes: Number(market.seedNoKes),
      rake: Number(market.rake),
      options: options.map((o) => ({
        optionId: o.id,
        label: o.label,
        seedKes: Number(o.seedKes),
      })),
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

    const isMulti = market.marketType === 'MULTI';

    if (isMulti && !dto.winningOptionId) {
      throw new BadRequestException(
        'winningOptionId is required to resolve a multi-outcome market',
      );
    }
    if (!isMulti && !dto.outcome) {
      throw new BadRequestException('outcome is required to resolve a binary market');
    }

    let winningLabel = dto.outcome as string | undefined;

    if (isMulti) {
      const winner = await this.prisma.marketOption.findFirst({
        where: { id: dto.winningOptionId, marketId },
      });
      if (!winner) {
        throw new BadRequestException('winningOptionId does not belong to this market');
      }
      winningLabel = winner.label;

      await this.prisma.marketOption.updateMany({
        where: { marketId },
        data: { isWinner: false },
      });
      await this.prisma.marketOption.update({
        where: { id: winner.id },
        data: { isWinner: true },
      });
    }

    const updated = await this.prisma.market.update({
      where: { id: marketId },
      data: {
        status: 'RESOLVED',
        // resolvedOutcome is the binary YES/NO enum; a MULTI winner is recorded
        // on the MarketOption row instead.
        resolvedOutcome: isMulti ? null : (dto.outcome as any),
        resolutionNote: dto.note,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    });

    const options = isMulti
      ? await this.prisma.marketOption.findMany({ where: { marketId } })
      : [];
    const totalPool = isMulti
      ? options.reduce((s, o) => s + Number(o.poolKes), 0)
      : Number(market.poolYesKes) + Number(market.poolNoKes);

    await this.kafka.publish(KAFKA_TOPICS.MARKET_RESOLVED, {
      marketId,
      marketType: market.marketType,
      outcome: winningLabel,
      winningOptionId: dto.winningOptionId,
      totalPoolKes: totalPool,
      rake: Number(market.rake),
      resolvedAt: new Date().toISOString(),
    });

    this.logger.log(`Market resolved: ${marketId} → ${winningLabel}`);
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

  /**
   * trading-service owns the pool during a trade and publishes the result here.
   * Without this subscription the market row keeps its seed pools forever and
   * totalVolume / tradeCount / price history all stay at zero.
   */
  async startKafkaConsumers() {
    await this.kafka.subscribe<{
      marketId: string;
      poolYesKes: number;
      poolNoKes: number;
      volumeDelta: number;
    }>(
      'market-service-price-updated-group',
      [KAFKA_TOPICS.MARKET_PRICE_UPDATED],
      async (_topic, payload) => {
        await this.updatePoolStats(
          payload.marketId,
          payload.poolYesKes,
          payload.poolNoKes,
          payload.volumeDelta,
        );
      },
    );
    this.logger.log('Market Kafka consumers registered');
  }

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

  /**
   * The Prisma columns are openAt/closeAt/resolveAt, but api.html documents the
   * wire shape as closesAt/resolvesAt and clients read those names. Both are
   * emitted so existing consumers of the column names keep working.
   */
  private toMarketResponse<T extends { closeAt?: Date | null; resolveAt?: Date | null }>(
    market: T,
  ): T & { closesAt?: string | null; resolvesAt?: string | null } {
    return {
      ...market,
      closesAt: market.closeAt ? new Date(market.closeAt).toISOString() : null,
      resolvesAt: market.resolveAt ? new Date(market.resolveAt).toISOString() : null,
    };
  }

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
