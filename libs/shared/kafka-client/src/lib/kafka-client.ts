import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Kafka, Producer, Consumer, Admin, logLevel } from 'kafkajs';

// ─── Kafka Topic Constants ────────────────────────────────────────────────────

export const KAFKA_TOPICS = {
  // Auth
  AUTH_USER_REGISTERED: 'kmkt.auth.user-registered',
  AUTH_USER_VERIFIED: 'kmkt.auth.user-verified',
  AUTH_SESSION_CREATED: 'kmkt.auth.session-created',

  // Market
  MARKET_CREATED: 'kmkt.market.created',
  MARKET_ACTIVATED: 'kmkt.market.activated',
  MARKET_CLOSED: 'kmkt.market.closed',
  MARKET_RESOLVED: 'kmkt.market.resolved',
  MARKET_CANCELLED: 'kmkt.market.cancelled',
  MARKET_PRICE_UPDATED: 'kmkt.market.price-updated',
  MARKET_POOL_UPDATED: 'kmkt.market.pool-updated',

  // Trading
  TRADING_TRADE_INITIATED: 'kmkt.trading.trade-initiated',
  TRADING_TRADE_CONFIRMED: 'kmkt.trading.trade-confirmed',
  TRADING_TRADE_FAILED: 'kmkt.trading.trade-failed',
  TRADING_POSITION_UPDATED: 'kmkt.trading.position-updated',
  TRADING_MARKET_SETTLED: 'kmkt.trading.market-settled',

  // Wallet
  WALLET_CREDITED: 'kmkt.wallet.credited',
  WALLET_DEBITED: 'kmkt.wallet.debited',
  WALLET_RESERVE_CREATED: 'kmkt.wallet.reserve-created',
  WALLET_RESERVE_RELEASED: 'kmkt.wallet.reserve-released',

  // Payment
  PAYMENT_DEPOSIT_INITIATED: 'kmkt.payment.deposit-initiated',
  PAYMENT_DEPOSIT_COMPLETED: 'kmkt.payment.deposit-completed',
  PAYMENT_DEPOSIT_FAILED: 'kmkt.payment.deposit-failed',
  PAYMENT_WITHDRAWAL_INITIATED: 'kmkt.payment.withdrawal-initiated',
  PAYMENT_WITHDRAWAL_COMPLETED: 'kmkt.payment.withdrawal-completed',
  PAYMENT_WITHDRAWAL_FAILED: 'kmkt.payment.withdrawal-failed',
  PAYMENT_CALLBACK_RECEIVED: 'kmkt.payment.callback-received',

  // Notifications
  NOTIFICATION_SEND_SMS: 'kmkt.notification.send-sms',
  NOTIFICATION_SEND_PUSH: 'kmkt.notification.send-push',
  NOTIFICATION_SEND_EMAIL: 'kmkt.notification.send-email',

  // Analytics
  ANALYTICS_TRADE_EVENT: 'kmkt.analytics.trade-event',
  ANALYTICS_PAYMENT_EVENT: 'kmkt.analytics.payment-event',
  ANALYTICS_MARKET_EVENT: 'kmkt.analytics.market-event',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

// ─── Kafka Service ─────────────────────────────────────────────────────────────

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka: Kafka;
  private producer: Producer;
  private consumers: Map<string, Consumer> = new Map();

  constructor(brokers: string[], private readonly clientId: string) {
    this.kafka = new Kafka({
      clientId,
      brokers,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 300,
        retries: 10,
      },
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
    });
  }

  async onModuleInit() {
    await this.producer.connect();
    this.logger.log(`Kafka producer connected [clientId=${this.clientId}]`);
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
    for (const [groupId, consumer] of this.consumers) {
      await consumer.disconnect();
      this.logger.log(`Kafka consumer disconnected [groupId=${groupId}]`);
    }
  }

  async publish<T>(topic: KafkaTopic, payload: T, key?: string): Promise<void> {
    await this.producer.send({
      topic,
      messages: [
        {
          key: key ?? null,
          value: JSON.stringify(payload),
          headers: {
            'content-type': 'application/json',
            'produced-at': Date.now().toString(),
          },
        },
      ],
    });
  }

  async publishBatch<T>(
    messages: Array<{ topic: KafkaTopic; payload: T; key?: string }>,
  ): Promise<void> {
    const topicMessages = messages.reduce(
      (acc, { topic, payload, key }) => {
        const existing = acc.find((tm) => tm.topic === topic);
        const message = {
          key: key ?? null,
          value: JSON.stringify(payload),
          headers: { 'content-type': 'application/json' },
        };
        if (existing) {
          existing.messages.push(message);
        } else {
          acc.push({ topic, messages: [message] });
        }
        return acc;
      },
      [] as Array<{ topic: string; messages: Array<{ key: string | null; value: string; headers: Record<string, string> }> }>,
    );

    await this.producer.sendBatch({ topicMessages });
  }

  async subscribe<T>(
    groupId: string,
    topics: KafkaTopic[],
    handler: (topic: string, payload: T, key?: string) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    this.consumers.set(groupId, consumer);

    await consumer.connect();
    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        try {
          const payload = JSON.parse(message.value?.toString() ?? '{}') as T;
          const key = message.key?.toString();
          await handler(topic, payload, key);
        } catch (err) {
          this.logger.error(`Failed to process message from ${topic}`, err);
        }
      },
    });

    this.logger.log(`Kafka consumer running [groupId=${groupId}] topics=[${topics.join(', ')}]`);
  }

  getAdmin(): Admin {
    return this.kafka.admin();
  }
}
