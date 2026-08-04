import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import type { TradeConfirmedPayload, MarketSettledPayload } from '@org/types';
import { PrismaService } from './prisma.service';

// ─── Raw query row types ──────────────────────────────────────────────────────

interface LeaderboardRow {
  user_id: string;
  volume_kes: string;
  trade_count: string | number;
}

// ─── Analytics Service ────────────────────────────────────────────────────────

@Injectable()
export class AnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
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
    const won = outcome === winningOutcome;

    try {
      // Cost basis isn't on this payload — sum what TradeEvent already
      // recorded for this user in this market (every trade lands there
      // before settlement can ever fire).
      const spend = await this.prisma.tradeEvent.aggregate({
        where: { userId, marketId },
        _sum: { amountKes: true },
      });
      const costKes = Number(spend._sum.amountKes ?? 0);

      await this.prisma.settlementEvent.upsert({
        where: { userId_marketId: { userId, marketId } },
        update: {},
        create: { userId, marketId, won, payoutKes, costKes },
      });

      this.logger.debug(
        `Settlement recorded: marketId=${marketId} userId=${userId} won=${won} payoutKes=${payoutKes} costKes=${costKes}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Failed to record SettlementEvent marketId=${marketId} userId=${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Leaderboard ───────────────────────────────────────────────────────────

  async getLeaderboard(
    period: string,
    category: string,
    page: number,
    limit: number,
  ): Promise<{
    period: string;
    category: string;
    data: Array<{
      rank: number;
      userId: string;
      displayName: string;
      profitKes: number;
      tradeCount: number;
      winRate: number;
    }>;
    total: number;
  }> {
    const skip = (page - 1) * limit;
    // The frontend sends the friendly name ("weekly"); rows are stored
    // under the resolved key computeLeaderboard actually writes to
    // ("2026-W32") — querying by the literal string never matched a row.
    const resolvedPeriod = this.resolvePeriodKey(period);

    const [entries, total] = await Promise.all([
      this.prisma.leaderboardEntry.findMany({
        where: { period: resolvedPeriod, category },
        orderBy: { pnlKes: 'desc' },
        skip,
        take: limit,
        select: {
          rank: true,
          userId: true,
          pnlKes: true,
          tradeCount: true,
          winRate: true,
        },
      }),
      this.prisma.leaderboardEntry.count({ where: { period: resolvedPeriod, category } }),
    ]);

    const displayNames = await this.fetchDisplayNames(entries.map((e) => e.userId));

    return {
      period,
      category,
      data: entries.map((e, i) => ({
        rank: e.rank ?? skip + i + 1,
        userId: e.userId,
        displayName: displayNames[e.userId] ?? 'Trader',
        profitKes: Number(e.pnlKes),
        tradeCount: e.tradeCount,
        winRate: Number(e.winRate),
      })),
      total,
    };
  }

  private async fetchDisplayNames(userIds: string[]): Promise<Record<string, string>> {
    if (userIds.length === 0) return {};
    const userServiceUrl = this.config.get('USER_SERVICE_URL', 'http://localhost:3002');
    const internalKey = this.config.get('INTERNAL_API_KEY');
    try {
      const response = await firstValueFrom(
        this.http.get<Record<string, string>>(
          `${userServiceUrl}/api/internal/users/display-names`,
          { params: { ids: userIds.join(',') }, headers: { 'x-internal-key': internalKey } },
        ),
      );
      return response.data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch display names for leaderboard: ${msg}`);
      return {};
    }
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
    const [volumeRow, settlements] = await Promise.all([
      this.prisma.tradeEvent.aggregate({
        where: { userId },
        _sum: { amountKes: true },
        _count: { _all: true },
      }),
      // Win rate and PnL are only meaningful once a market has settled —
      // an open position is neither a win nor a loss yet.
      this.prisma.settlementEvent.findMany({
        where: { userId },
        select: { won: true, payoutKes: true, costKes: true },
      }),
    ]);

    const settledCount = settlements.length;
    const winCount = settlements.filter((s) => s.won).length;
    const totalPnlKes = settlements.reduce(
      (sum, s) => sum + (Number(s.payoutKes) - Number(s.costKes)),
      0,
    );

    return {
      userId,
      totalVolumeKes: Number(volumeRow._sum.amountKes ?? 0),
      totalTrades: volumeRow._count._all,
      totalPnlKes,
      winRate: settledCount > 0 ? winCount / settledCount : 0,
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

      // Column names are Prisma's camelCase mapping ("userId", "amountKes",
      // "occurredAt"), not snake_case — this query used the wrong names for
      // every single run, so the leaderboard cron has never once succeeded.
      const rows = await this.prisma.$queryRaw<LeaderboardRow[]>`
        SELECT
          "userId"                                AS user_id,
          COALESCE(SUM("amountKes"), 0)::text      AS volume_kes,
          COUNT(*)::text                            AS trade_count
        FROM trade_events
        WHERE "occurredAt" >= ${periodStart}
          AND "occurredAt" <  ${periodEnd}
        GROUP BY "userId"
      `;

      if (!rows.length) {
        this.logger.debug(`No trade events found for period=${targetPeriod}`);
        return;
      }

      // PnL and win rate come from settlements within the same window —
      // previously hardcoded to 0/0 here, so the leaderboard never actually
      // ranked by profit despite sorting "by pnlKes desc" below.
      const settlements = await this.prisma.settlementEvent.findMany({
        where: { settledAt: { gte: periodStart, lt: periodEnd } },
        select: { userId: true, won: true, payoutKes: true, costKes: true },
      });
      const settlementsByUser = new Map<string, { won: boolean; payoutKes: number; costKes: number }[]>();
      for (const s of settlements) {
        const list = settlementsByUser.get(s.userId) ?? [];
        list.push({ won: s.won, payoutKes: Number(s.payoutKes), costKes: Number(s.costKes) });
        settlementsByUser.set(s.userId, list);
      }

      // Upsert each user's leaderboard entry
      for (const row of rows) {
        const volumeKes = Number(row.volume_kes);
        const tradeCount = Number(row.trade_count);
        const userSettlements = settlementsByUser.get(row.user_id) ?? [];
        const pnlKes = userSettlements.reduce((sum, s) => sum + (s.payoutKes - s.costKes), 0);
        const winRate = userSettlements.length > 0
          ? userSettlements.filter((s) => s.won).length / userSettlements.length
          : 0;

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
            pnlKes,
            volumeKes,
            tradeCount,
            winRate,
            computedAt: new Date(),
          },
          update: {
            pnlKes,
            volumeKes,
            tradeCount,
            winRate,
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
        "marketId"                               AS market_id,
        COALESCE(SUM("amountKes"), 0)::text      AS volume_kes,
        COUNT(*)::text                            AS trade_count
      FROM trade_events
      WHERE "occurredAt" >= ${periodStart}
        AND "occurredAt" <  ${periodEnd}
      GROUP BY "marketId"
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

  /**
   * Only "weekly" (this week, computed hourly by the cron below) has a real
   * data source today — daily/monthly/all-time views were never computed by
   * anything, so a request for one of those falls back to weekly rather than
   * silently returning nothing for a period the UI still shows as an option.
   */
  private resolvePeriodKey(period: string): string {
    if (/^\d{4}-W\d{2}$/.test(period)) return period; // already a stored key
    return this.currentWeeklyPeriod();
  }

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
