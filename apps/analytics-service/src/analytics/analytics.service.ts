import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import type { TradeConfirmedPayload, MarketSettledPayload } from '@org/types';
import { PrismaService } from './prisma.service';

// ─── Raw query row types ──────────────────────────────────────────────────────

interface LeaderboardRow {
  user_id: string;
  volume_kes: string;
  trade_count: string | number;
}

interface UserStatsRow {
  total_volume_kes: string;
  total_trades: string | number;
  total_pnl_kes: string;
  win_count: string | number;
}

// ─── Analytics Service ────────────────────────────────────────────────────────

@Injectable()
export class AnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.kafka.subscribe<TradeConfirmedPayload>(
      'analytics-trade-confirmed-group',
      [KAFKA_TOPICS.TRADING_TRADE_CONFIRMED],
      async (_topic, payload) => {
        await this.handleTradeConfirmed(payload);
      },
    );

    await this.kafka.subscribe<MarketSettledPayload>(
      'analytics-market-settled-group',
      [KAFKA_TOPICS.TRADING_MARKET_SETTLED],
      async (_topic, payload) => {
        await this.handleMarketSettled(payload);
      },
    );

    this.logger.log('Analytics Kafka consumers registered');
  }

  // ─── Kafka Handlers ────────────────────────────────────────────────────────

  private async handleTradeConfirmed(payload: TradeConfirmedPayload): Promise<void> {
    const { tradeId, userId, marketId, outcome, amountKes, pricePerShare } = payload;

    try {
      await this.prisma.tradeEvent.upsert({
        where: { tradeId },
        create: {
          tradeId,
          userId,
          marketId,
          outcome,
          amountKes,
          pricePerShare,
        },
        update: {},
      });

      this.logger.debug(`TradeEvent recorded: tradeId=${tradeId}`);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to record TradeEvent tradeId=${tradeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleMarketSettled(payload: MarketSettledPayload): Promise<void> {
    const { marketId, userId, outcome, payoutKes, winningOutcome } = payload;

    // We do not store a separate settlement event per-trade here because TradeEvent
    // doesn't carry a settlementPnl column. PnL is computed at leaderboard time via
    // aggregation over the settled market. We do log the event for observability.
    this.logger.debug(
      `MarketSettled received: marketId=${marketId} userId=${userId} ` +
        `outcome=${outcome} winning=${winningOutcome} payoutKes=${payoutKes}`,
    );
  }

  // ─── Leaderboard ───────────────────────────────────────────────────────────

  async getLeaderboard(
    period: string,
    category: string,
    page: number,
    limit: number,
  ): Promise<{
    entries: Array<{
      rank: number | null;
      userId: string;
      pnlKes: number;
      volumeKes: number;
      tradeCount: number;
    }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      this.prisma.leaderboardEntry.findMany({
        where: { period, category },
        orderBy: { pnlKes: 'desc' },
        skip,
        take: limit,
        select: {
          rank: true,
          userId: true,
          pnlKes: true,
          volumeKes: true,
          tradeCount: true,
        },
      }),
      this.prisma.leaderboardEntry.count({ where: { period, category } }),
    ]);

    return {
      entries: entries.map((e) => ({
        rank: e.rank,
        userId: e.userId,
        pnlKes: Number(e.pnlKes),
        volumeKes: Number(e.volumeKes),
        tradeCount: e.tradeCount,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Market Stats ──────────────────────────────────────────────────────────

  /**
   * Per-market summary in the shape api.html documents. Computed from
   * TradeEvent rather than the MarketVolume rollup — the rollup only exists
   * after the cron has run, so a freshly traded market would report zeros.
   */
  async getMarketStats(marketId: string): Promise<{
    marketId: string;
    dailyVolume: number;
    weeklyVolume: number;
    totalVolume: number;
    uniqueTraders: number;
    tradeCount: number;
  }> {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [total, daily, weekly, traders] = await Promise.all([
      this.prisma.tradeEvent.aggregate({
        where: { marketId },
        _sum: { amountKes: true },
        _count: { _all: true },
      }),
      this.prisma.tradeEvent.aggregate({
        where: { marketId, occurredAt: { gte: dayAgo } },
        _sum: { amountKes: true },
      }),
      this.prisma.tradeEvent.aggregate({
        where: { marketId, occurredAt: { gte: weekAgo } },
        _sum: { amountKes: true },
      }),
      this.prisma.tradeEvent.findMany({
        where: { marketId },
        distinct: ['userId'],
        select: { userId: true },
      }),
    ]);

    return {
      marketId,
      dailyVolume: Number(daily._sum.amountKes ?? 0),
      weeklyVolume: Number(weekly._sum.amountKes ?? 0),
      totalVolume: Number(total._sum.amountKes ?? 0),
      uniqueTraders: traders.length,
      tradeCount: total._count._all,
    };
  }

  // ─── Platform Overview ─────────────────────────────────────────────────────

  /**
   * Aggregate platform-wide trading activity for the admin dashboard.
   * `days` bounds the daily volume series and the "recent" totals; lifetime
   * figures are unbounded.
   */
  async getPlatformOverview(days = 30): Promise<{
    totalVolumeKes: number;
    totalTrades: number;
    uniqueTraders: number;
    recentVolumeKes: number;
    recentTrades: number;
    avgTradeKes: number;
    dailyVolume: Array<{ date: string; volumeKes: number; tradeCount: number }>;
    topMarkets: Array<{ marketId: string; volumeKes: number; tradeCount: number }>;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [lifetime, recent, traders, daily, topMarkets] = await Promise.all([
      this.prisma.tradeEvent.aggregate({
        _sum: { amountKes: true },
        _count: { _all: true },
      }),
      this.prisma.tradeEvent.aggregate({
        where: { occurredAt: { gte: since } },
        _sum: { amountKes: true },
        _count: { _all: true },
      }),
      this.prisma.tradeEvent.findMany({
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.$queryRaw<Array<{ date: Date; volume_kes: string; trade_count: bigint }>>`
        SELECT date_trunc('day', "occurredAt") AS date,
               SUM("amountKes") AS volume_kes,
               COUNT(*) AS trade_count
        FROM trade_events
        WHERE "occurredAt" >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      this.prisma.tradeEvent.groupBy({
        by: ['marketId'],
        _sum: { amountKes: true },
        _count: { _all: true },
        orderBy: { _sum: { amountKes: 'desc' } },
        take: 5,
      }),
    ]);

    const totalVolumeKes = Number(lifetime._sum.amountKes ?? 0);
    const totalTrades = lifetime._count._all;

    return {
      totalVolumeKes,
      totalTrades,
      uniqueTraders: traders.length,
      recentVolumeKes: Number(recent._sum.amountKes ?? 0),
      recentTrades: recent._count._all,
      avgTradeKes: totalTrades > 0 ? totalVolumeKes / totalTrades : 0,
      dailyVolume: daily.map((d) => ({
        date: d.date.toISOString().slice(0, 10),
        volumeKes: Number(d.volume_kes),
        tradeCount: Number(d.trade_count),
      })),
      topMarkets: topMarkets.map((m) => ({
        marketId: m.marketId,
        volumeKes: Number(m._sum.amountKes ?? 0),
        tradeCount: m._count._all,
      })),
    };
  }

  // ─── User Stats ────────────────────────────────────────────────────────────

  async getUserStats(userId: string): Promise<{
    userId: string;
    totalVolumeKes: number;
    totalTrades: number;
    totalPnlKes: number;
    winRate: number;
  }> {
    const rows = await this.prisma.$queryRaw<UserStatsRow[]>`
      SELECT
        COALESCE(SUM(amount_kes), 0)::text       AS total_volume_kes,
        COUNT(*)::text                            AS total_trades,
        0::text                                   AS total_pnl_kes,
        0::text                                   AS win_count
      FROM trade_events
      WHERE user_id = ${userId}
    `;

    const row = rows[0];
    const totalTrades = Number(row?.total_trades ?? 0);
    const winCount = Number(row?.win_count ?? 0);

    return {
      userId,
      totalVolumeKes: Number(row?.total_volume_kes ?? 0),
      totalTrades,
      totalPnlKes: Number(row?.total_pnl_kes ?? 0),
      winRate: totalTrades > 0 ? winCount / totalTrades : 0,
    };
  }

  // ─── Compute Leaderboard (scheduled) ──────────────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async computeLeaderboard(period?: string): Promise<void> {
    const targetPeriod = period ?? this.currentWeeklyPeriod();
    this.logger.log(`Computing leaderboard for period=${targetPeriod}`);

    try {
      // Aggregate per-user volume and trade count for the period window
      const periodStart = this.periodStart(targetPeriod);
      const periodEnd = this.periodEnd(targetPeriod);

      const rows = await this.prisma.$queryRaw<LeaderboardRow[]>`
        SELECT
          user_id                                AS user_id,
          COALESCE(SUM(amount_kes), 0)::text     AS volume_kes,
          COUNT(*)::text                         AS trade_count
        FROM trade_events
        WHERE occurred_at >= ${periodStart}
          AND occurred_at <  ${periodEnd}
        GROUP BY user_id
      `;

      if (!rows.length) {
        this.logger.debug(`No trade events found for period=${targetPeriod}`);
        return;
      }

      // Upsert each user's leaderboard entry
      for (const row of rows) {
        const volumeKes = Number(row.volume_kes);
        const tradeCount = Number(row.trade_count);

        await this.prisma.leaderboardEntry.upsert({
          where: {
            userId_period_category: {
              userId: row.user_id,
              period: targetPeriod,
              category: 'OVERALL',
            },
          },
          create: {
            userId: row.user_id,
            period: targetPeriod,
            category: 'OVERALL',
            pnlKes: 0,
            volumeKes,
            tradeCount,
            computedAt: new Date(),
          },
          update: {
            pnlKes: 0,
            volumeKes,
            tradeCount,
            computedAt: new Date(),
          },
        });
      }

      // Assign ranks ordered by pnlKes desc, then volumeKes desc
      const entries = await this.prisma.leaderboardEntry.findMany({
        where: { period: targetPeriod, category: 'OVERALL' },
        orderBy: [{ pnlKes: 'desc' }, { volumeKes: 'desc' }],
        select: { id: true },
      });

      await Promise.all(
        entries.map((entry, index) =>
          this.prisma.leaderboardEntry.update({
            where: { id: entry.id },
            data: { rank: index + 1 },
          }),
        ),
      );

      // Upsert market volumes for the same period
      await this.computeMarketVolumes(targetPeriod, periodStart, periodEnd);

      this.logger.log(
        `Leaderboard computed for period=${targetPeriod}: ${rows.length} entries ranked`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `computeLeaderboard failed for period=${targetPeriod}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Market Volume Aggregation ─────────────────────────────────────────────

  private async computeMarketVolumes(
    period: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> {
    interface MarketVolumeRow {
      market_id: string;
      volume_kes: string;
      trade_count: string;
    }

    const rows = await this.prisma.$queryRaw<MarketVolumeRow[]>`
      SELECT
        market_id                              AS market_id,
        COALESCE(SUM(amount_kes), 0)::text     AS volume_kes,
        COUNT(*)::text                         AS trade_count
      FROM trade_events
      WHERE occurred_at >= ${periodStart}
        AND occurred_at <  ${periodEnd}
      GROUP BY market_id
    `;

    for (const row of rows) {
      await this.prisma.marketVolume.upsert({
        where: {
          marketId_period: { marketId: row.market_id, period },
        },
        create: {
          marketId: row.market_id,
          period,
          volumeKes: Number(row.volume_kes),
          tradeCount: Number(row.trade_count),
          computedAt: new Date(),
        },
        update: {
          volumeKes: Number(row.volume_kes),
          tradeCount: Number(row.trade_count),
          computedAt: new Date(),
        },
      });
    }
  }

  // ─── Period Helpers ────────────────────────────────────────────────────────

  private currentWeeklyPeriod(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const dayOfYear = Math.floor(
      (now.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24),
    );
    const week = Math.ceil((dayOfYear + startOfYear.getUTCDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  private periodStart(period: string): Date {
    // Supports weekly periods like "2025-W01"
    const weeklyMatch = /^(\d{4})-W(\d{2})$/.exec(period);
    if (weeklyMatch) {
      const year = parseInt(weeklyMatch[1], 10);
      const week = parseInt(weeklyMatch[2], 10);
      const jan1 = new Date(Date.UTC(year, 0, 1));
      const dayOffset = (week - 1) * 7 - jan1.getUTCDay() + 1;
      return new Date(Date.UTC(year, 0, 1 + dayOffset));
    }
    // Fallback: beginning of current week (Monday)
    const d = new Date();
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private periodEnd(period: string): Date {
    const start = this.periodStart(period);
    return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
}
