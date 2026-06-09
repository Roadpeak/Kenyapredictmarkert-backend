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

  async getMarketStats(marketId: string): Promise<
    Array<{
      period: string;
      volumeKes: number;
      tradeCount: number;
      computedAt: Date;
    }>
  > {
    const volumes = await this.prisma.marketVolume.findMany({
      where: { marketId },
      orderBy: { period: 'asc' },
    });

    return volumes.map((v) => ({
      period: v.period,
      volumeKes: Number(v.volumeKes),
      tradeCount: v.tradeCount,
      computedAt: v.computedAt,
    }));
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
