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
    await this.assertMarketActive(dto.marketId);

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
            outcome: dto.outcome,
            amountKes: dto.amountKes,
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
    const pools = await this.prisma.marketPool.findMany({
      where: { marketId: { in: marketIds } },
    });

    const poolMap = new Map(pools.map((p) => [p.marketId, p]));

    return positions.map((pos) => {
      const pool = poolMap.get(pos.marketId);
      const currentPrice = pool
        ? pos.outcome === 'YES'
          ? calcYesPrice(Number(pool.poolYesKes), Number(pool.poolNoKes))
          : calcNoPrice(Number(pool.poolYesKes), Number(pool.poolNoKes))
        : Number(pos.avgPriceKes);

      const currentValue = Number(pos.totalShares) * SHARE_PRICE_KES * currentPrice;
      const costBasis = Number(pos.totalCostKes);
      const unrealizedPnl = currentValue - costBasis;

      return {
        ...pos,
        currentPrice,
        currentValue,
        costBasis,
        unrealizedPnl,
        unrealizedPnlPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
      };
    });
  }

  async getMarketPosition(userId: string, marketId: string) {
    return this.prisma.position.findMany({
      where: { userId, marketId },
    });
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

  async getMarketTrades(marketId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
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

    // Mark losing positions as settled (no payout)
    await this.prisma.position.updateMany({
      where: { marketId, outcome: outcome === 'YES' ? 'NO' : 'YES', isSettled: false },
      data: { isSettled: true, payoutKes: 0 },
    });

    // Publish one settlement message per winner (fan-out) — wallet-service and notification-service consume
    await this.kafka.publishBatch(
      settlements.map((s) => ({
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
    );

    this.logger.log(`Settlement fan-out sent for market ${marketId}: ${settlements.length} winners`);
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
    await this.kafka.subscribe<MarketResolvedPayload>(
      'trading-service-resolution-group',
      [KAFKA_TOPICS.MARKET_RESOLVED],
      async (_topic, payload) => {
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
    try {
      await firstValueFrom(
        this.http.post(`${walletUrl}/api/internal/wallet/reserve`, {
          userId,
          amount,
          referenceId,
          referenceType: 'TRADE',
        }),
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
    await firstValueFrom(
      this.http.post(`${walletUrl}/api/internal/wallet/debit`, {
        userId,
        amount,
        referenceId: tradeId,
        referenceType: 'TRADE_DEBIT',
        description: `Trade ${tradeId}`,
      }),
    );
  }

  private async releaseWalletReserve(userId: string, amount: number, referenceId: string) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    try {
      await firstValueFrom(
        this.http.post(`${walletUrl}/api/internal/wallet/release`, {
          userId,
          amount,
          referenceId,
        }),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to release reserve for user ${userId}: ${msg}`);
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
}
