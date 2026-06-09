import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import type {
  TradeConfirmedPayload,
  MarketSettledPayload,
  DepositCompletedPayload,
  WithdrawalCompletedPayload,
  MarketResolvedPayload,
} from '@org/types';

export interface FeedItem {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

// In-memory feed with capped per-user history — for production use Redis sorted sets
const MAX_FEED_ITEMS = 50;
const userFeeds = new Map<string, FeedItem[]>();

function addToFeed(item: FeedItem) {
  const feed = userFeeds.get(item.userId) ?? [];
  feed.unshift(item);
  if (feed.length > MAX_FEED_ITEMS) feed.length = MAX_FEED_ITEMS;
  userFeeds.set(item.userId, feed);
}

@Injectable()
export class FeedService implements OnModuleInit {
  private readonly logger = new Logger(FeedService.name);
  private readonly marketServiceUrl: string;

  constructor(
    private readonly kafka: KafkaService,
    config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.marketServiceUrl = config.get('MARKET_SERVICE_URL', 'http://localhost:3003');
  }

  async onModuleInit() {
    await this.kafka.subscribe<TradeConfirmedPayload>(
      'feed-trade-confirmed-group',
      [KAFKA_TOPICS.TRADING_TRADE_CONFIRMED],
      async (_topic, payload) => {
        addToFeed({
          id: payload.tradeId,
          userId: payload.userId,
          type: 'TRADE_CONFIRMED',
          title: 'Trade Placed',
          body: `You bought ${payload.sharesCount} ${payload.outcome} shares on "${payload.marketTitle}" for KES ${payload.amountKes.toLocaleString()}`,
          metadata: {
            marketId: payload.marketId,
            outcome: payload.outcome,
            amountKes: payload.amountKes,
          },
          occurredAt: new Date(),
        });
      },
    );

    await this.kafka.subscribe<MarketSettledPayload>(
      'feed-settlement-group',
      [KAFKA_TOPICS.TRADING_MARKET_SETTLED],
      async (_topic, payload) => {
        const won = payload.outcome === payload.winningOutcome;
        addToFeed({
          id: `settle:${payload.marketId}:${payload.userId}`,
          userId: payload.userId,
          type: 'MARKET_SETTLED',
          title: won ? 'You Won!' : 'Market Settled',
          body: won
            ? `KES ${payload.payoutKes.toLocaleString()} credited for "${payload.marketTitle}"`
            : `Market "${payload.marketTitle}" resolved as ${payload.winningOutcome}`,
          metadata: {
            marketId: payload.marketId,
            payoutKes: payload.payoutKes,
            won,
          },
          occurredAt: new Date(),
        });
      },
    );

    await this.kafka.subscribe<DepositCompletedPayload>(
      'feed-deposit-group',
      [KAFKA_TOPICS.PAYMENT_DEPOSIT_COMPLETED],
      async (_topic, payload) => {
        addToFeed({
          id: payload.paymentId,
          userId: payload.userId,
          type: 'DEPOSIT_COMPLETED',
          title: 'Deposit Received',
          body: `KES ${payload.amountKes.toLocaleString()} deposited via M-Pesa`,
          metadata: {
            amountKes: payload.amountKes,
            mpesaReceiptNumber: payload.mpesaReceiptNumber,
          },
          occurredAt: new Date(),
        });
      },
    );

    await this.kafka.subscribe<WithdrawalCompletedPayload>(
      'feed-withdrawal-group',
      [KAFKA_TOPICS.PAYMENT_WITHDRAWAL_COMPLETED],
      async (_topic, payload) => {
        addToFeed({
          id: payload.paymentId,
          userId: payload.userId,
          type: 'WITHDRAWAL_COMPLETED',
          title: 'Withdrawal Sent',
          body: `KES ${payload.amountKes.toLocaleString()} sent to ${payload.phone} via M-Pesa`,
          metadata: { amountKes: payload.amountKes },
          occurredAt: new Date(),
        });
      },
    );

    await this.kafka.subscribe<MarketResolvedPayload>(
      'feed-market-resolved-group',
      [KAFKA_TOPICS.MARKET_RESOLVED],
      async (_topic, payload) => {
        // Global event — could broadcast to all subscribers of this market
        // For now just log; WebSocket gateway handles the room broadcast
        this.logger.log(`Market resolved: ${payload.marketId} → ${payload.outcome}`);
      },
    );

    this.logger.log('Feed Kafka consumers registered');
  }

  getUserFeed(userId: string, page: number, limit: number) {
    const feed = userFeeds.get(userId) ?? [];
    const start = (page - 1) * limit;
    const items = feed.slice(start, start + limit);
    return { items, total: feed.length, page, limit };
  }

  async getDiscoveryFeed(page: number, limit: number) {
    // Proxy to market-service for active markets sorted by volume
    try {
      const response = await firstValueFrom(
        this.http.get<unknown>(`${this.marketServiceUrl}/api/markets`, {
          params: { status: 'ACTIVE', page, limit, sort: 'volume' },
        }),
      );
      return response.data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch discovery feed: ${msg}`);
      return { data: [], meta: { total: 0, page, limit } };
    }
  }
}
