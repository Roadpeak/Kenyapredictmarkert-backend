import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from './prisma.service';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import {
  calcYesPrice,
  calcNoPrice,
  calcSharesReceived,
  calcPayoutPerShare,
  generateSettlementId,
} from '@org/utils';
import { Outcome, MarketResolvedPayload, MarketCancelledPayload } from '@org/types';
import { PlaceTradeDto } from './trading.dto';

const SHARE_PRICE_KES = 10; // Fixed share price
const MAX_OPTIMISTIC_LOCK_RETRIES = 3;

interface HolderRow {
  userId: string;
  displayName: string;
  sharesHeld: number;
  costKes: number;
  currentPrice: number;
  currentValue: number;
}

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  // ─── Place Trade (core — with optimistic locking) ─────────────────────────────

  async placeTrade(userId: string, dto: PlaceTradeDto) {
    // Check for duplicate trade
    const existing = await this.prisma.trade.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== userId) throw new BadRequestException('Invalid idempotency key');
      return existing; // Idempotent — return existing
    }

    // Verify market is active via market-service
    const market = await this.assertMarketActive(dto.marketId);

    // Reserve funds in wallet-service before touching pool
    await this.reserveWalletFunds(userId, dto.amountKes, dto.idempotencyKey);

    let retries = 0;
    while (retries < MAX_OPTIMISTIC_LOCK_RETRIES) {
      try {
        const trade = await this.executeTradeWithOptimisticLock(userId, dto);

        // Release reserved funds and debit actual amount
        await this.confirmWalletDebit(userId, dto.amountKes, trade.id, dto.idempotencyKey);

        // Notify market-service to update pool stats
        await this.notifyMarketPoolUpdate(dto.marketId, trade);

        // Publish trade confirmed
        await this.kafka.publish(
          KAFKA_TOPICS.TRADING_TRADE_CONFIRMED,
          {
            tradeId: trade.id,
            userId,
            marketId: dto.marketId,
            marketTitle: market?.title ?? dto.marketId,
            outcome: dto.outcome,
            amountKes: dto.amountKes,
            sharesCount: Number(trade.sharesReceived),
            sharesReceived: Number(trade.sharesReceived),
            pricePerShare: Number(trade.pricePerShare),
          },
          dto.marketId,
        );

        await this.kafka.publish(KAFKA_TOPICS.ANALYTICS_TRADE_EVENT, {
          tradeId: trade.id,
          userId,
          marketId: dto.marketId,
          outcome: dto.outcome,
          amountKes: dto.amountKes,
          pricePerShare: Number(trade.pricePerShare),
        });

        return {
          tradeId: trade.id,
          marketId: dto.marketId,
          outcome: dto.outcome,
          amountKes: dto.amountKes,
          sharesReceived: Number(trade.sharesReceived),
          pricePerShare: Number(trade.pricePerShare),
          impliedProbability: `${(Number(trade.pricePerShare) * 100).toFixed(1)}%`,
          status: 'CONFIRMED',
        };
      } catch (err: unknown) {
        // P2025 = Prisma record not found (optimistic lock version mismatch)
        if ((err as { code?: string })?.code === 'P2025' && retries < MAX_OPTIMISTIC_LOCK_RETRIES - 1) {
          retries++;
          this.logger.warn(`Pool version conflict for market ${dto.marketId}, retry ${retries}`);
          continue;
        }
        // Release reserved funds on failure
        await this.releaseWalletReserve(userId, dto.amountKes, dto.idempotencyKey);
        throw new ConflictException('Market is busy. Please retry your trade.');
      }
    }

    await this.releaseWalletReserve(userId, dto.amountKes, dto.idempotencyKey);
    throw new ConflictException('Market is busy. Please retry your trade.');
  }

  private async executeTradeWithOptimisticLock(userId: string, dto: PlaceTradeDto) {
    const pool = await this.prisma.marketPool.findUnique({
      where: { marketId: dto.marketId },
    });

    if (!pool) {
      throw new NotFoundException(`No pool found for market ${dto.marketId}`);
    }

    const poolYes = Number(pool.poolYesKes);
    const poolNo = Number(pool.poolNoKes);
    const isYes = dto.outcome === 'YES';

    const pricePerShare = isYes
      ? calcYesPrice(poolYes, poolNo)
      : calcNoPrice(poolYes, poolNo);

    const sharesReceived = calcSharesReceived(dto.amountKes, SHARE_PRICE_KES);

    const newPoolYes = isYes ? poolYes + dto.amountKes : poolYes;
    const newPoolNo = !isYes ? poolNo + dto.amountKes : poolNo;

    const [, trade] = await this.prisma.$transaction([
      // Optimistic lock: only succeeds if version matches
      this.prisma.marketPool.update({
        where: { marketId: dto.marketId, version: pool.version },
        data: {
          poolYesKes: newPoolYes,
          poolNoKes: newPoolNo,
          totalShares: { increment: sharesReceived },
          yesShares: isYes ? { increment: sharesReceived } : undefined,
          noShares: !isYes ? { increment: sharesReceived } : undefined,
          version: { increment: 1 },
        },
      }),
      this.prisma.trade.create({
        data: {
          userId,
          marketId: dto.marketId,
          outcome: dto.outcome as Outcome,
          amountKes: dto.amountKes,
          sharesReceived,
          pricePerShare,
          poolYesAtTrade: poolYes,
          poolNoAtTrade: poolNo,
          status: 'CONFIRMED',
          idempotencyKey: dto.idempotencyKey,
        },
      }),
    ]);

    // Upsert position
    await this.prisma.position.upsert({
      where: {
        userId_marketId_outcome: {
          userId,
          marketId: dto.marketId,
          outcome: dto.outcome as Outcome,
        },
      },
      update: {
        totalShares: { increment: sharesReceived },
        totalCostKes: { increment: dto.amountKes },
        avgPriceKes: {
          // Weighted average price
          set: (await this.getUpdatedAvgPrice(userId, dto.marketId, dto.outcome as Outcome, dto.amountKes, sharesReceived, pricePerShare)),
        },
      },
      create: {
        userId,
        marketId: dto.marketId,
        outcome: dto.outcome as Outcome,
        totalShares: sharesReceived,
        totalCostKes: dto.amountKes,
        avgPriceKes: pricePerShare,
      },
    });

    return trade;
  }

  // ─── Get positions ────────────────────────────────────────────────────────────

  async getMyPositions(userId: string) {
    const positions = await this.prisma.position.findMany({
      where: { userId, isSettled: false },
      orderBy: { updatedAt: 'desc' },
    });

    // Enrich with current pool prices
    const marketIds = [...new Set(positions.map((p) => p.marketId))];
    const [pools, titles] = await Promise.all([
      this.prisma.marketPool.findMany({ where: { marketId: { in: marketIds } } }),
      this.resolveMarketTitles(marketIds),
    ]);

    const poolMap = new Map(pools.map((p) => [p.marketId, p]));

    return positions.map((pos) => {
      const pool = poolMap.get(pos.marketId);
      const currentPrice = pool
        ? pos.outcome === 'YES'
          ? calcYesPrice(Number(pool.poolYesKes), Number(pool.poolNoKes))
          : calcNoPrice(Number(pool.poolYesKes), Number(pool.poolNoKes))
        : Number(pos.avgPriceKes);

      const sharesHeld = Number(pos.totalShares);
      const costKes = Number(pos.totalCostKes);
      const currentValue = sharesHeld * SHARE_PRICE_KES * currentPrice;
      const unrealizedPnl = currentValue - costKes;

      // Field names follow api.html (sharesHeld/costKes), not the raw
      // Decimal columns (totalShares/totalCostKes, serialized as strings) —
      // the frontend renders these directly and previously got NaN for both.
      return {
        ...pos,
        marketTitle: titles.get(pos.marketId) ?? pos.marketId,
        sharesHeld,
        costKes,
        currentPrice,
        currentValue,
        unrealizedPnl,
        unrealizedPnlPct: costKes > 0 ? (unrealizedPnl / costKes) * 100 : 0,
      };
    });
  }

  /**
   * Every position on one market, with real user identity — the admin
   * counterpart to the public, anonymized getMarketTrades. Works for a
   * market in any status: called on an ACTIVE/CLOSED market this is "who
   * has staked and what they chose right now"; called on a RESOLVED market
   * the same isSettled/payoutKes fields show who won, who lost, and by how
   * much. Binary and MULTI positions are merged into one roster since an
   * admin looking at a market doesn't care which table backs it.
   */
  async getMarketRoster(marketId: string, page: number, limit: number) {
    const [binary, options] = await Promise.all([
      this.prisma.position.findMany({ where: { marketId } }),
      this.prisma.optionPosition.findMany({ where: { marketId } }),
    ]);

    const userIds = [...new Set([...binary.map((p) => p.userId), ...options.map((p) => p.userId)])];
    const displayNames = await this.resolveDisplayNames(userIds);

    const roster = [
      ...binary.map((p) => ({
        userId: p.userId,
        displayName: displayNames.get(p.userId) ?? 'Trader',
        label: p.outcome,
        sharesHeld: Number(p.totalShares),
        costKes: Number(p.totalCostKes),
        isSettled: p.isSettled,
        payoutKes: p.payoutKes !== null ? Number(p.payoutKes) : null,
        won: p.isSettled ? Number(p.payoutKes ?? 0) > 0 : null,
        updatedAt: p.updatedAt.toISOString(),
      })),
      ...options.map((p) => ({
        userId: p.userId,
        displayName: displayNames.get(p.userId) ?? 'Trader',
        label: p.label,
        sharesHeld: Number(p.totalShares),
        costKes: Number(p.totalCostKes),
        isSettled: p.isSettled,
        payoutKes: p.payoutKes !== null ? Number(p.payoutKes) : null,
        won: p.isSettled ? Number(p.payoutKes ?? 0) > 0 : null,
        updatedAt: p.updatedAt.toISOString(),
      })),
    ].sort((a, b) => b.costKes - a.costKes);

    const total = roster.length;
    const start = (page - 1) * limit;
    const data = roster.slice(start, start + limit);

    return {
      data,
      total,
      page,
      limit,
      winnerCount: roster.filter((r) => r.won === true).length,
      loserCount: roster.filter((r) => r.won === false).length,
      totalStakedKes: roster.reduce((sum, r) => sum + r.costKes, 0),
      totalPaidOutKes: roster.reduce((sum, r) => sum + (r.payoutKes ?? 0), 0),
    };
  }

  /**
   * Top holders for a market, ranked by CURRENT position value (not cost),
   * split per outcome/option — like Polymarket's own Top Holders, this is
   * deliberately identity-revealing (unlike the anonymized public
   * getMarketTrades) since surfacing who's backing which side is the point
   * of the feature. Unlike getMarketRoster (admin-only, sorted by cost,
   * no live price), this is public and composes the same currentValue calc
   * getMyPositions/getMyOptionPositions already do per-caller, but across
   * every holder of the market at once.
   */
  async getMarketHolders(marketId: string): Promise<
    | { marketType: 'BINARY'; yes: HolderRow[]; no: HolderRow[] }
    | { marketType: 'MULTI'; options: { optionId: string; label: string; holders: HolderRow[] }[] }
  > {
    const hasOptions = (await this.prisma.optionPool.count({ where: { marketId } })) > 0;

    if (hasOptions) {
      const positions = await this.prisma.optionPosition.findMany({
        where: { marketId, isSettled: false },
      });
      const pools = await this.prisma.optionPool.findMany({ where: { marketId } });
      const total = pools.reduce((sum, p) => sum + Number(p.poolKes), 0);
      const priceMap = new Map(
        pools.map((p) => [p.optionId, total > 0 ? Number(p.poolKes) / total : 1 / (pools.length || 1)]),
      );
      const labelByOption = new Map(pools.map((p) => [p.optionId, p.label]));

      const displayNames = await this.resolveDisplayNames(positions.map((p) => p.userId));

      const holdersByOption = new Map<string, HolderRow[]>();
      for (const pos of positions) {
        const currentPrice = priceMap.get(pos.optionId) ?? Number(pos.avgPriceKes);
        const sharesHeld = Number(pos.totalShares);
        const costKes = Number(pos.totalCostKes);
        const row: HolderRow = {
          userId: pos.userId,
          displayName: displayNames.get(pos.userId) ?? 'Trader',
          sharesHeld,
          costKes,
          currentPrice,
          currentValue: sharesHeld * SHARE_PRICE_KES * currentPrice,
        };
        const list = holdersByOption.get(pos.optionId) ?? [];
        list.push(row);
        holdersByOption.set(pos.optionId, list);
      }

      const options = pools.map((p) => ({
        optionId: p.optionId,
        label: labelByOption.get(p.optionId) ?? p.label,
        holders: (holdersByOption.get(p.optionId) ?? [])
          .sort((a, b) => b.currentValue - a.currentValue)
          .slice(0, 50),
      }));

      return { marketType: 'MULTI', options };
    }

    const [positions, pool] = await Promise.all([
      this.prisma.position.findMany({ where: { marketId, isSettled: false } }),
      this.prisma.marketPool.findUnique({ where: { marketId } }),
    ]);

    const yesPrice = pool ? calcYesPrice(Number(pool.poolYesKes), Number(pool.poolNoKes)) : 0.5;
    const noPrice = pool ? calcNoPrice(Number(pool.poolYesKes), Number(pool.poolNoKes)) : 0.5;

    const displayNames = await this.resolveDisplayNames(positions.map((p) => p.userId));

    const yes: HolderRow[] = [];
    const no: HolderRow[] = [];
    for (const pos of positions) {
      const currentPrice = pos.outcome === 'YES' ? yesPrice : noPrice;
      const sharesHeld = Number(pos.totalShares);
      const costKes = Number(pos.totalCostKes);
      const row: HolderRow = {
        userId: pos.userId,
        displayName: displayNames.get(pos.userId) ?? 'Trader',
        sharesHeld,
        costKes,
        currentPrice,
        currentValue: sharesHeld * SHARE_PRICE_KES * currentPrice,
      };
      (pos.outcome === 'YES' ? yes : no).push(row);
    }

    yes.sort((a, b) => b.currentValue - a.currentValue);
    no.sort((a, b) => b.currentValue - a.currentValue);

    return { marketType: 'BINARY', yes: yes.slice(0, 50), no: no.slice(0, 50) };
  }

  // Batch-resolves userId -> display name via user-service's internal
  // endpoint — same pattern as resolveMarketTitles, mirrored from
  // analytics-service's fetchDisplayNames since trading-service has no
  // existing user-service client of its own.
  private async resolveDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return new Map();

    const userServiceUrl = this.config.get('USER_SERVICE_URL', 'http://localhost:3002');
    const internalKey = this.config.get('INTERNAL_API_KEY');
    try {
      const response = await firstValueFrom(
        this.http.get<Record<string, string>>(
          `${userServiceUrl}/api/internal/users/display-names`,
          { params: { ids: uniqueIds.join(',') }, headers: { 'x-internal-key': internalKey } },
        ),
      );
      return new Map(Object.entries(response.data));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to resolve display names: ${msg}`);
      return new Map();
    }
  }

  /**
   * Settled positions (won or lost) across both binary and MULTI markets —
   * the counterpart to getMyPositions/getMyOptionPositions, which both
   * explicitly filter isSettled: false. Without this there was nowhere a
   * user could see a past result: the market title, whether they won, and
   * what they were paid.
   */
  async getMyResults(userId: string, page: number, limit: number) {
    const [binary, options] = await Promise.all([
      this.prisma.position.findMany({ where: { userId, isSettled: true } }),
      this.prisma.optionPosition.findMany({ where: { userId, isSettled: true } }),
    ]);

    const marketIds = [...new Set([...binary.map((p) => p.marketId), ...options.map((p) => p.marketId)])];
    const titles = await this.resolveMarketTitles(marketIds);

    const results = [
      ...binary.map((p) => ({
        marketId: p.marketId,
        marketTitle: titles.get(p.marketId) ?? p.marketId,
        label: p.outcome,
        sharesHeld: Number(p.totalShares),
        costKes: Number(p.totalCostKes),
        payoutKes: Number(p.payoutKes ?? 0),
        won: Number(p.payoutKes ?? 0) > 0,
        settledAt: p.updatedAt.toISOString(),
      })),
      ...options.map((p) => ({
        marketId: p.marketId,
        marketTitle: titles.get(p.marketId) ?? p.marketId,
        label: p.label,
        sharesHeld: Number(p.totalShares),
        costKes: Number(p.totalCostKes),
        payoutKes: Number(p.payoutKes ?? 0),
        won: Number(p.payoutKes ?? 0) > 0,
        settledAt: p.updatedAt.toISOString(),
      })),
    ].sort((a, b) => new Date(b.settledAt).getTime() - new Date(a.settledAt).getTime());

    const total = results.length;
    const start = (page - 1) * limit;
    const data = results.slice(start, start + limit);

    return { data, total, page, limit };
  }

  /**
   * The caller's single net position in one market, priced at the live pool.
   * A user can hold both YES and NO rows; the larger stake is the position
   * that is surfaced. Returns null when they hold nothing here.
   *
   * Field names follow api.html (sharesHeld / costKes / currentValue) rather
   * than the raw column names, because clients render this directly.
   */
  async getMarketPosition(userId: string, marketId: string) {
    const positions = await this.prisma.position.findMany({
      where: { userId, marketId },
    });
    if (positions.length === 0) return null;

    const position = positions.reduce((a, b) =>
      Number(b.totalShares) > Number(a.totalShares) ? b : a,
    );

    const pool = await this.prisma.marketPool.findUnique({ where: { marketId } });
    const currentPrice = pool
      ? position.outcome === 'YES'
        ? calcYesPrice(Number(pool.poolYesKes), Number(pool.poolNoKes))
        : calcNoPrice(Number(pool.poolYesKes), Number(pool.poolNoKes))
      : Number(position.avgPriceKes);

    const sharesHeld = Number(position.totalShares);
    const costKes = Number(position.totalCostKes);
    const currentValue = sharesHeld * SHARE_PRICE_KES * currentPrice;

    return {
      ...position,
      marketId,
      outcome: position.outcome,
      sharesHeld,
      costKes,
      currentPrice,
      currentValue,
      unrealizedPnl: currentValue - costKes,
    };
  }

  async getMyTrades(userId: string, page = 1, limit = 20, marketId?: string) {
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (marketId) where.marketId = marketId;

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.trade.count({ where }),
    ]);

    return { data: trades, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Own MULTI-market trade history. Kept as a separate call (rather than
   * merged into getMyTrades) because the two live in different tables with
   * different columns — merging them into one paginated, date-sorted list
   * would mean fetching both in full and re-paginating in memory.
   */
  async getMyOptionTrades(userId: string, page = 1, limit = 20, marketId?: string) {
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (marketId) where.marketId = marketId;

    const [trades, total] = await Promise.all([
      this.prisma.optionTrade.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.optionTrade.count({ where }),
    ]);

    return { data: trades, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getMarketTrades(marketId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    // A MULTI market's trades live in optionTrade, not trade — detect it by
    // whether this marketId has any option pools rather than calling out to
    // market-service just to read marketType.
    const hasOptions = (await this.prisma.optionPool.count({ where: { marketId } })) > 0;

    if (hasOptions) {
      const [trades, total] = await Promise.all([
        this.prisma.optionTrade.findMany({
          where: { marketId, status: 'CONFIRMED' },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            label: true,
            amountKes: true,
            pricePerShare: true,
            createdAt: true,
            // No userId — privacy
          },
        }),
        this.prisma.optionTrade.count({ where: { marketId } }),
      ]);

      return { data: trades, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where: { marketId, status: 'CONFIRMED' },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          outcome: true,
          amountKes: true,
          pricePerShare: true,
          createdAt: true,
          // No userId — privacy
        },
      }),
      this.prisma.trade.count({ where: { marketId } }),
    ]);

    return { data: trades, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Settlement (triggered by market.resolved Kafka event) ───────────────────

  async settleMarket(payload: MarketResolvedPayload) {
    const { marketId, marketTitle, outcome, totalPoolKes, rake } = payload;

    const winningPositions = await this.prisma.position.findMany({
      where: { marketId, outcome: outcome as Outcome, isSettled: false },
    });

    if (winningPositions.length === 0) {
      this.logger.warn(`No winning positions for market ${marketId}`);
      return;
    }

    const pool = await this.prisma.marketPool.findUnique({ where: { marketId } });
    const winningShares =
      outcome === 'YES' ? Number(pool?.yesShares ?? 0) : Number(pool?.noShares ?? 0);

    const payoutPerShare = calcPayoutPerShare(totalPoolKes, rake, winningShares);

    const settlements = [];

    for (const position of winningPositions) {
      const payoutKes = Number(position.totalShares) * payoutPerShare;
      generateSettlementId(marketId, position.userId, outcome); // used for idempotency key in upsert where clause

      await this.prisma.settlement.upsert({
        where: { marketId_userId_outcome: { marketId, userId: position.userId, outcome: outcome as Outcome } },
        update: {},
        create: {
          marketId,
          userId: position.userId,
          outcome: outcome as Outcome,
          sharesHeld: position.totalShares,
          payoutKes,
          status: 'PROCESSING',
        },
      });

      await this.prisma.position.update({
        where: { id: position.id },
        data: { isSettled: true, payoutKes },
      });

      settlements.push({ userId: position.userId, sharesHeld: Number(position.totalShares), payoutKes });
    }

    // Losing side — settled with no payout, but still fanned out below so
    // these users get a "market resolved" notification too, not just silence.
    const losingOutcome = outcome === 'YES' ? 'NO' : 'YES';
    const losingPositions = await this.prisma.position.findMany({
      where: { marketId, outcome: losingOutcome, isSettled: false },
    });
    await this.prisma.position.updateMany({
      where: { marketId, outcome: losingOutcome, isSettled: false },
      data: { isSettled: true, payoutKes: 0 },
    });

    // Publish one settlement message per position holder, winners and losers
    // alike (fan-out) — wallet-service and notification-service consume.
    // Previously only winners were published here, so a losing position
    // never told its owner the market had even resolved.
    await this.kafka.publishBatch(
      [
        ...settlements.map((s) => ({
          topic: KAFKA_TOPICS.TRADING_MARKET_SETTLED,
          key: s.userId,
          payload: {
            marketId,
            marketTitle: marketTitle ?? marketId,
            winningOutcome: outcome as Outcome,
            userId: s.userId,
            outcome: outcome as Outcome,
            payoutKes: s.payoutKes,
            sharesHeld: s.sharesHeld,
          },
        })),
        ...losingPositions.map((p) => ({
          topic: KAFKA_TOPICS.TRADING_MARKET_SETTLED,
          key: p.userId,
          payload: {
            marketId,
            marketTitle: marketTitle ?? marketId,
            winningOutcome: outcome as Outcome,
            userId: p.userId,
            outcome: losingOutcome as Outcome,
            payoutKes: 0,
            sharesHeld: Number(p.totalShares),
          },
        })),
      ],
    );

    this.logger.log(
      `Settlement fan-out sent for market ${marketId}: ${settlements.length} winners, ${losingPositions.length} losers`,
    );
  }

  // ─── Refund all positions (cancelled market) ──────────────────────────────────

  async refundMarket(payload: MarketCancelledPayload) {
    const { marketId } = payload;

    const positions = await this.prisma.position.findMany({
      where: { marketId, isSettled: false },
    });

    const refunds = positions.map((p) => ({
      userId: p.userId,
      amountKes: Number(p.totalCostKes),
    }));

    await this.prisma.position.updateMany({
      where: { marketId, isSettled: false },
      data: { isSettled: true, payoutKes: 0 },
    });

    // Wallet-service handles the refunds
    for (const refund of refunds) {
      await this.kafka.publish(KAFKA_TOPICS.WALLET_CREDITED, {
        userId: refund.userId,
        amount: refund.amountKes,
        referenceId: marketId,
        referenceType: 'REFUND',
        description: `Refund for cancelled market ${marketId}`,
      }, refund.userId);
    }

    this.logger.log(`Refunds sent for cancelled market ${marketId}: ${refunds.length} positions`);
  }

  // ─── Kafka consumers ──────────────────────────────────────────────────────────

  async startKafkaConsumers() {
    await this.kafka.subscribe<
      MarketResolvedPayload & { marketType?: 'BINARY' | 'MULTI'; winningOptionId?: string }
    >(
      'trading-service-resolution-group',
      [KAFKA_TOPICS.MARKET_RESOLVED],
      async (_topic, payload) => {
        if (payload.marketType === 'MULTI' && payload.winningOptionId) {
          await this.settleOptionMarket(payload.marketId, payload.winningOptionId, payload.marketTitle);
          return;
        }
        await this.settleMarket(payload);
      },
    );

    await this.kafka.subscribe<MarketCancelledPayload>(
      'trading-service-cancel-group',
      [KAFKA_TOPICS.MARKET_CANCELLED],
      async (_topic, payload) => {
        await this.refundMarket(payload);
      },
    );

    await this.kafka.subscribe<{
      marketId: string;
      marketType?: 'BINARY' | 'MULTI';
      seedYesKes?: number;
      seedNoKes?: number;
      rake?: number;
      options?: Array<{ optionId: string; label: string; seedKes: number }>;
    }>(
      'trading-service-activation-group',
      [KAFKA_TOPICS.MARKET_ACTIVATED],
      async (_topic, payload) => {
        if (payload.marketType === 'MULTI') {
          await this.initOptionPools(
            payload.marketId,
            payload.options ?? [],
            payload.rake ?? 0.04,
          );
          this.logger.log(
            `Option pools initialised for ${payload.marketId} (${payload.options?.length ?? 0} options)`,
          );
          return;
        }

        await this.initMarketPool(
          payload.marketId,
          payload.seedYesKes ?? 1000,
          payload.seedNoKes ?? 1000,
          payload.rake ?? 0.04,
        );
        this.logger.log(`Market pool initialised for ${payload.marketId}`);
      },
    );
  }

  // ─── MarketPool bootstrap (called when market is activated) ──────────────────

  async initMarketPool(marketId: string, seedYesKes: number, seedNoKes: number, rake: number) {
    await this.prisma.marketPool.upsert({
      where: { marketId },
      update: {},
      create: {
        marketId,
        poolYesKes: seedYesKes,
        poolNoKes: seedNoKes,
        rake,
        version: 0,
      },
    });
  }

  // ─── MULTI markets ────────────────────────────────────────────────────────────
  //
  // Pick-a-winner markets ("who wins the Ballon d'Or?") run on their own tables
  // so the binary YES/NO path — and every settlement rule that depends on it —
  // is untouched. The maths is the same parimutuel model: an option's price is
  // its share of the pot, and the winning side splits the whole pot net of rake.

  async initOptionPools(
    marketId: string,
    options: Array<{ optionId: string; label: string; seedKes: number }>,
    rake: number,
  ) {
    for (const opt of options) {
      await this.prisma.optionPool.upsert({
        where: { optionId: opt.optionId },
        update: {},
        create: {
          marketId,
          optionId: opt.optionId,
          label: opt.label,
          poolKes: opt.seedKes,
          rake,
          version: 0,
        },
      });
    }
  }

  /** Live prices for one MULTI market — each option's share of the pot. */
  /**
   * All of the caller's MULTI-market positions across every market — the
   * pick-a-winner equivalent of getMyPositions.
   */
  async getMyOptionPositions(userId: string) {
    const positions = await this.prisma.optionPosition.findMany({
      where: { userId, isSettled: false },
      orderBy: { updatedAt: 'desc' },
    });
    if (positions.length === 0) return [];

    const marketIds = [...new Set(positions.map((p) => p.marketId))];
    const pools = await this.prisma.optionPool.findMany({ where: { marketId: { in: marketIds } } });
    const totalsByMarket = new Map<string, number>();
    for (const p of pools) {
      totalsByMarket.set(p.marketId, (totalsByMarket.get(p.marketId) ?? 0) + Number(p.poolKes));
    }
    const poolByOption = new Map(pools.map((p) => [p.optionId, p]));

    return positions.map((pos) => {
      const pool = poolByOption.get(pos.optionId);
      const total = totalsByMarket.get(pos.marketId) ?? 0;
      const currentPrice = pool
        ? total > 0
          ? Number(pool.poolKes) / total
          : 1 / (pools.filter((p) => p.marketId === pos.marketId).length || 1)
        : Number(pos.avgPriceKes);

      const sharesHeld = Number(pos.totalShares);
      const costKes = Number(pos.totalCostKes);
      const currentValue = sharesHeld * SHARE_PRICE_KES * currentPrice;

      return {
        marketId: pos.marketId,
        optionId: pos.optionId,
        label: pos.label,
        sharesHeld,
        costKes,
        currentPrice,
        currentValue,
        unrealizedPnl: currentValue - costKes,
      };
    });
  }

  /**
   * The caller's positions in a MULTI market — one row per option they hold,
   * unlike binary's single net position, since a user can back more than one
   * runner in a pick-a-winner market.
   */
  async getMarketOptionPositions(userId: string, marketId: string) {
    const positions = await this.prisma.optionPosition.findMany({
      where: { userId, marketId, isSettled: false },
    });
    if (positions.length === 0) return [];

    const pools = await this.prisma.optionPool.findMany({ where: { marketId } });
    const total = pools.reduce((sum, p) => sum + Number(p.poolKes), 0);
    const priceMap = new Map(
      pools.map((p) => [p.optionId, total > 0 ? Number(p.poolKes) / total : 1 / (pools.length || 1)]),
    );

    return positions.map((pos) => {
      const currentPrice = priceMap.get(pos.optionId) ?? Number(pos.avgPriceKes);
      const sharesHeld = Number(pos.totalShares);
      const costKes = Number(pos.totalCostKes);
      const currentValue = sharesHeld * SHARE_PRICE_KES * currentPrice;

      return {
        marketId,
        optionId: pos.optionId,
        label: pos.label,
        sharesHeld,
        costKes,
        currentPrice,
        currentValue,
        unrealizedPnl: currentValue - costKes,
      };
    });
  }

  async getOptionPrices(marketId: string) {
    const pools = await this.prisma.optionPool.findMany({ where: { marketId } });
    const total = pools.reduce((sum, p) => sum + Number(p.poolKes), 0);

    return pools.map((p) => ({
      optionId: p.optionId,
      label: p.label,
      poolKes: Number(p.poolKes),
      totalShares: Number(p.totalShares),
      price: total > 0 ? Number(p.poolKes) / total : 1 / (pools.length || 1),
    }));
  }

  async placeOptionTrade(
    userId: string,
    dto: { marketId: string; optionId: string; amountKes: number; idempotencyKey: string },
  ) {
    const existing = await this.prisma.optionTrade.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== userId) {
        throw new BadRequestException('Idempotency key already used');
      }
      return existing;
    }

    const pool = await this.prisma.optionPool.findUnique({
      where: { optionId: dto.optionId },
    });
    if (!pool || pool.marketId !== dto.marketId) {
      throw new NotFoundException('Option not found for this market');
    }

    const market = await this.assertMarketActive(dto.marketId);
    await this.reserveWalletFunds(userId, dto.amountKes, dto.idempotencyKey);

    try {
      const trade = await this.executeOptionTrade(userId, dto, Number(pool.rake));
      await this.confirmWalletDebit(userId, dto.amountKes, trade.id, dto.idempotencyKey);

      // market-service's own copy of each option's poolKes/price only moves
      // when told to — mirrors notifyMarketPoolUpdate's binary equivalent.
      await this.notifyOptionPoolUpdate(dto.marketId, dto.amountKes);

      await this.kafka.publish(
        KAFKA_TOPICS.TRADING_TRADE_CONFIRMED,
        {
          tradeId: trade.id,
          userId,
          marketId: dto.marketId,
          marketTitle: market?.title ?? dto.marketId,
          outcome: trade.label,
          amountKes: dto.amountKes,
          sharesCount: Number(trade.sharesReceived),
          sharesReceived: Number(trade.sharesReceived),
          pricePerShare: Number(trade.pricePerShare),
        },
        dto.marketId,
      );

      await this.kafka.publish(KAFKA_TOPICS.ANALYTICS_TRADE_EVENT, {
        tradeId: trade.id,
        userId,
        marketId: dto.marketId,
        outcome: trade.label,
        amountKes: dto.amountKes,
        pricePerShare: Number(trade.pricePerShare),
        occurredAt: new Date().toISOString(),
      });

      return {
        tradeId: trade.id,
        marketId: dto.marketId,
        optionId: dto.optionId,
        label: trade.label,
        amountKes: Number(trade.amountKes),
        sharesReceived: Number(trade.sharesReceived),
        pricePerShare: Number(trade.pricePerShare),
        status: trade.status,
      };
    } catch (err) {
      await this.releaseWalletReserve(userId, dto.amountKes, dto.idempotencyKey);
      throw err;
    }
  }

  private async executeOptionTrade(
    userId: string,
    dto: { marketId: string; optionId: string; amountKes: number; idempotencyKey: string },
    rake: number,
  ) {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_LOCK_RETRIES; attempt++) {
      const pool = await this.prisma.optionPool.findUnique({
        where: { optionId: dto.optionId },
      });
      if (!pool) throw new NotFoundException('Option pool missing');

      const allPools = await this.prisma.optionPool.findMany({
        where: { marketId: dto.marketId },
      });
      const totalPot = allPools.reduce((s, p) => s + Number(p.poolKes), 0);
      const price =
        totalPot > 0 ? Number(pool.poolKes) / totalPot : 1 / (allPools.length || 1);

      const shares = dto.amountKes / SHARE_PRICE_KES;

      try {
        return await this.prisma.$transaction(async (tx) => {
          const updated = await tx.optionPool.updateMany({
            where: { optionId: dto.optionId, version: pool.version },
            data: {
              poolKes: { increment: dto.amountKes },
              totalShares: { increment: shares },
              version: { increment: 1 },
            },
          });
          // Someone else moved the pool between read and write — retry.
          if (updated.count === 0) throw new ConflictException('retry');

          const trade = await tx.optionTrade.create({
            data: {
              userId,
              marketId: dto.marketId,
              optionId: dto.optionId,
              label: pool.label,
              amountKes: dto.amountKes,
              sharesReceived: shares,
              pricePerShare: price,
              poolAtTrade: Number(pool.poolKes),
              status: 'CONFIRMED',
              idempotencyKey: dto.idempotencyKey,
            },
          });

          const existingPos = await tx.optionPosition.findUnique({
            where: { userId_optionId: { userId, optionId: dto.optionId } },
          });

          if (existingPos) {
            const newShares = Number(existingPos.totalShares) + shares;
            const newCost = Number(existingPos.totalCostKes) + dto.amountKes;
            await tx.optionPosition.update({
              where: { id: existingPos.id },
              data: {
                totalShares: newShares,
                totalCostKes: newCost,
                avgPriceKes: newCost / (newShares * SHARE_PRICE_KES),
              },
            });
          } else {
            await tx.optionPosition.create({
              data: {
                userId,
                marketId: dto.marketId,
                optionId: dto.optionId,
                label: pool.label,
                totalShares: shares,
                totalCostKes: dto.amountKes,
                avgPriceKes: price,
              },
            });
          }

          return trade;
        });
      } catch (err) {
        if (err instanceof ConflictException && attempt < MAX_OPTIMISTIC_LOCK_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }

    throw new ConflictException('Market is busy. Please retry your trade.');
  }

  /**
   * Settle a MULTI market: the winning option's holders split the entire pot
   * across all options, net of rake. Losing options' stakes fund the payout,
   * exactly as the binary path works.
   */
  async settleOptionMarket(marketId: string, winningOptionId: string, marketTitle?: string) {
    const pools = await this.prisma.optionPool.findMany({ where: { marketId } });
    if (pools.length === 0) return;

    const totalPot = pools.reduce((s, p) => s + Number(p.poolKes), 0);
    const rake = Number(pools[0].rake);

    const winners = await this.prisma.optionPosition.findMany({
      where: { marketId, optionId: winningOptionId, isSettled: false },
    });
    if (winners.length === 0) {
      this.logger.warn(`No winning positions for MULTI market ${marketId}`);
      return;
    }

    const winningShares = winners.reduce((s, p) => s + Number(p.totalShares), 0);
    const payoutPerShare = calcPayoutPerShare(totalPot, rake, winningShares);
    const winningLabel = pools.find((p) => p.optionId === winningOptionId)?.label ?? '';

    const settlements: Array<{ userId: string; payoutKes: number }> = [];

    for (const pos of winners) {
      const payoutKes = Number(pos.totalShares) * payoutPerShare;

      await this.prisma.optionPosition.update({
        where: { id: pos.id },
        data: { isSettled: true, payoutKes },
      });

      settlements.push({ userId: pos.userId, payoutKes });
    }

    // Losing positions are settled with a zero payout so they stop showing as open.
    const losers = await this.prisma.optionPosition.findMany({
      where: { marketId, optionId: { not: winningOptionId }, isSettled: false },
    });
    await this.prisma.optionPosition.updateMany({
      where: { marketId, optionId: { not: winningOptionId }, isSettled: false },
      data: { isSettled: true, payoutKes: 0 },
    });

    // wallet-service credits the payout off this event, same as the binary path.
    // Losers are fanned out too (payoutKes: 0) — previously only winners
    // published here, so a losing MULTI position never told its owner the
    // market had resolved, and analytics' settlement totals only ever saw
    // the winning side, making platform-earnings math come out negative.
    await this.kafka.publishBatch([
      ...settlements.map((s) => ({
        topic: KAFKA_TOPICS.TRADING_MARKET_SETTLED,
        key: s.userId,
        payload: {
          marketId,
          marketTitle: marketTitle ?? marketId,
          winningOutcome: winningLabel,
          userId: s.userId,
          outcome: winningLabel,
          payoutKes: s.payoutKes,
        },
      })),
      ...losers.map((p) => ({
        topic: KAFKA_TOPICS.TRADING_MARKET_SETTLED,
        key: p.userId,
        payload: {
          marketId,
          marketTitle: marketTitle ?? marketId,
          winningOutcome: winningLabel,
          userId: p.userId,
          outcome: p.label,
          payoutKes: 0,
        },
      })),
    ]);

    this.logger.log(
      `MULTI market ${marketId} settled — ${winners.length} winning positions, ${losers.length} losing positions, pot ${totalPot}`,
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async getUpdatedAvgPrice(
    userId: string,
    marketId: string,
    outcome: Outcome,
    newAmountKes: number,
    newShares: number,
    newPrice: number,
  ): Promise<number> {
    const existing = await this.prisma.position.findUnique({
      where: { userId_marketId_outcome: { userId, marketId, outcome } },
    });
    if (!existing) return newPrice;
    const existingShares = Number(existing.totalShares);
    const totalShares = existingShares + newShares;
    return (existingShares * Number(existing.avgPriceKes) + newShares * newPrice) / totalShares;
  }

  private async reserveWalletFunds(userId: string, amount: number, referenceId: string) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.getOrThrow('INTERNAL_API_KEY');
    try {
      await firstValueFrom(
        this.http.post(
          `${walletUrl}/api/internal/wallet/reserve`,
          {
            userId,
            amount,
            referenceId,
            referenceType: 'TRADE',
          },
          { headers: { 'x-internal-key': internalKey } },
        ),
      );
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Insufficient balance';
      throw new BadRequestException(message);
    }
  }

  private async confirmWalletDebit(
    userId: string,
    amount: number,
    tradeId: string,
    referenceId: string,
  ) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.getOrThrow('INTERNAL_API_KEY');
    await firstValueFrom(
      this.http.post(
        `${walletUrl}/api/internal/wallet/debit`,
        {
          userId,
          amount,
          referenceId: tradeId,
          referenceType: 'TRADE_DEBIT',
          description: `Trade ${tradeId}`,
        },
        { headers: { 'x-internal-key': internalKey } },
      ),
    );

    // debit only moves `balance`; without this the reserve placed before the
    // trade stays on the wallet forever and permanently locks the funds.
    await this.releaseWalletReserve(userId, amount, referenceId);
  }

  // This is the only thing standing between a failed trade and a user's
  // money being stuck in `reservedBalance` forever — wallet-service's own
  // optimistic-lock retries can still be exhausted under heavy concurrent
  // contention on one wallet row, so a single un-retried attempt here isn't
  // enough. Three attempts with a short backoff so a second wave of
  // contention on the wallet row has time to clear before giving up.
  private async releaseWalletReserve(userId: string, amount: number, referenceId: string) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.getOrThrow('INTERNAL_API_KEY');
    const MAX_RELEASE_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_RELEASE_ATTEMPTS; attempt++) {
      try {
        await firstValueFrom(
          this.http.post(
            `${walletUrl}/api/internal/wallet/release`,
            {
              userId,
              amount,
              referenceId,
            },
            { headers: { 'x-internal-key': internalKey } },
          ),
        );
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_RELEASE_ATTEMPTS) {
          this.logger.error(
            `Failed to release reserve for user ${userId} after ${MAX_RELEASE_ATTEMPTS} attempts — ` +
              `KES ${amount} remains stuck in reservedBalance until manually reconciled: ${msg}`,
          );
          return;
        }
        this.logger.warn(`Release reserve attempt ${attempt} failed for user ${userId}, retrying: ${msg}`);
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
  }

  // Batch-resolves marketId -> title via market-service's /markets/batch —
  // trading-service doesn't own market data, so every place that surfaces a
  // position or trade to a user needs this rather than showing the raw id.
  private async resolveMarketTitles(marketIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(marketIds)];
    if (uniqueIds.length === 0) return new Map();

    const marketUrl = this.config.get('MARKET_SERVICE_URL', 'http://localhost:3003');
    try {
      const response = await firstValueFrom(
        this.http.get<Array<{ id: string; title: string }>>(
          `${marketUrl}/api/markets/batch`,
          { params: { ids: uniqueIds.join(',') } },
        ),
      );
      return new Map(response.data.map((m) => [m.id, m.title]));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to resolve market titles: ${msg}`);
      return new Map();
    }
  }

  private async assertMarketActive(marketId: string) {
    const marketUrl = this.config.get('MARKET_SERVICE_URL', 'http://localhost:3003');
    try {
      const response = await firstValueFrom(
        this.http.get(`${marketUrl}/api/markets/${marketId}`),
      );
      const market = response.data;
      if (market?.status !== 'ACTIVE') {
        throw new BadRequestException(`Market is not accepting trades (status: ${market?.status})`);
      }
      // market-service auto-closes past-deadline markets on a 1-minute
      // cron — this check is the safety net for that window, so a trade
      // placed in the gap between the deadline passing and the next cron
      // tick still gets rejected instead of silently going through.
      if (market.closesAt && new Date(market.closesAt) <= new Date()) {
        throw new BadRequestException('Market is not accepting trades (past closing time)');
      }
      return market;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new NotFoundException(`Market ${marketId} not found`);
    }
  }

  private async notifyMarketPoolUpdate(marketId: string, trade: any) {
    const pool = await this.prisma.marketPool.findUnique({ where: { marketId } });
    if (!pool) return;

    await this.kafka.publish(
      KAFKA_TOPICS.MARKET_PRICE_UPDATED,
      {
        marketId,
        poolYesKes: Number(pool.poolYesKes),
        poolNoKes: Number(pool.poolNoKes),
        volumeDelta: Number(trade.amountKes),
      },
      marketId,
    );
  }

  private async notifyOptionPoolUpdate(marketId: string, volumeDelta: number) {
    const pools = await this.prisma.optionPool.findMany({ where: { marketId } });
    if (pools.length === 0) return;

    await this.kafka.publish(
      KAFKA_TOPICS.MARKET_OPTION_PRICE_UPDATED,
      {
        marketId,
        options: pools.map((p) => ({ optionId: p.optionId, poolKes: Number(p.poolKes), totalShares: Number(p.totalShares) })),
        volumeDelta,
      },
      marketId,
    );
  }
}
