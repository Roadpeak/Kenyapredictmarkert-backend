import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { NotificationService } from './notification.service';
import type {
  TradeConfirmedPayload,
  MarketSettledPayload,
  DepositCompletedPayload,
  WithdrawalCompletedPayload,
  WithdrawalFailedPayload,
} from '@org/types';

@Injectable()
export class NotificationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly notificationService: NotificationService,
  ) {}

  async onModuleInit() {
    await this.kafka.subscribe<TradeConfirmedPayload>(
      'notification-trade-group',
      [KAFKA_TOPICS.TRADING_TRADE_CONFIRMED],
      async (_topic, payload) => {
        await this.notificationService.onTradeConfirmed(payload);
      },
    );

    await this.kafka.subscribe<MarketSettledPayload>(
      'notification-settlement-group',
      [KAFKA_TOPICS.TRADING_MARKET_SETTLED],
      async (_topic, payload) => {
        await this.notificationService.onMarketSettled(payload);
      },
    );

    await this.kafka.subscribe<DepositCompletedPayload>(
      'notification-deposit-group',
      [KAFKA_TOPICS.PAYMENT_DEPOSIT_COMPLETED],
      async (_topic, payload) => {
        await this.notificationService.onDepositCompleted(payload);
      },
    );

    await this.kafka.subscribe<WithdrawalCompletedPayload>(
      'notification-withdrawal-group',
      [KAFKA_TOPICS.PAYMENT_WITHDRAWAL_COMPLETED],
      async (_topic, payload) => {
        await this.notificationService.onWithdrawalCompleted(payload);
      },
    );

    await this.kafka.subscribe<WithdrawalFailedPayload>(
      'notification-withdrawal-failed-group',
      [KAFKA_TOPICS.PAYMENT_WITHDRAWAL_FAILED],
      async (_topic, payload) => {
        await this.notificationService.onWithdrawalFailed(payload);
      },
    );

    this.logger.log('Notification Kafka consumers registered');
  }

  async onModuleDestroy() {
    // KafkaService handles consumer disconnects via its own onModuleDestroy
  }
}
