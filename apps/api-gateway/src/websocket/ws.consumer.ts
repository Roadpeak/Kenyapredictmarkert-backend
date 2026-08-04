import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { WsGateway } from './ws.gateway';
import { PaymentType, PaymentStatus } from '@org/types';
import type {
  MarketSettledPayload,
  DepositCompletedPayload,
  WithdrawalCompletedPayload,
  WithdrawalFailedPayload,
  NotificationCreatedPayload,
} from '@org/types';

@Injectable()
export class WsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly ws: WsGateway,
  ) {}

  async onModuleInit() {
    // Market price updates (published by market-service after pool stats update)
    await this.kafka.subscribe(
      'gateway-market-price-group',
      [KAFKA_TOPICS.MARKET_POOL_UPDATED],
      async (_topic, payload: any) => {
        this.ws.emitMarketPrice({
          marketId: payload.marketId as string,
          yesPrice: payload.yesPrice as number,
          noPrice: payload.noPrice as number,
          poolYesKes: payload.poolYesKes as number,
          poolNoKes: payload.poolNoKes as number,
          totalVolume: payload.totalVolume as number,
          tradeCount: payload.tradeCount as number,
          timestamp: Date.now(),
        });
      },
    );

    // Wallet credited after settlement — tell client to refetch balance, and
    // push the resolution itself so the frontend's market:settled listener
    // (previously wired up but nothing ever emitted it) actually fires, for
    // winners and losers alike.
    await this.kafka.subscribe<MarketSettledPayload>(
      'gateway-settlement-group',
      [KAFKA_TOPICS.TRADING_MARKET_SETTLED],
      async (_topic, payload) => {
        this.ws.emitWalletRefetch(payload.userId);
        this.ws.emitMarketSettled(payload);
      },
    );

    // Deposit completed
    await this.kafka.subscribe<DepositCompletedPayload>(
      'gateway-deposit-group',
      [KAFKA_TOPICS.PAYMENT_DEPOSIT_COMPLETED],
      async (_topic, payload) => {
        this.ws.emitPaymentUpdate(payload.userId, {
          paymentId: payload.paymentId,
          type: PaymentType.DEPOSIT,
          status: PaymentStatus.COMPLETED,
          amountKes: payload.amountKes,
          mpesaReceiptNumber: payload.mpesaReceiptNumber,
          timestamp: Date.now(),
        });
        this.ws.emitWalletRefetch(payload.userId);
      },
    );

    // Withdrawal completed
    await this.kafka.subscribe<WithdrawalCompletedPayload>(
      'gateway-withdrawal-group',
      [KAFKA_TOPICS.PAYMENT_WITHDRAWAL_COMPLETED],
      async (_topic, payload) => {
        this.ws.emitPaymentUpdate(payload.userId, {
          paymentId: payload.paymentId,
          type: PaymentType.WITHDRAWAL,
          status: PaymentStatus.COMPLETED,
          amountKes: payload.amountKes,
          mpesaReceiptNumber: payload.mpesaReceiptNumber,
          timestamp: Date.now(),
        });
      },
    );

    // Withdrawal failed
    await this.kafka.subscribe<WithdrawalFailedPayload>(
      'gateway-withdrawal-failed-group',
      [KAFKA_TOPICS.PAYMENT_WITHDRAWAL_FAILED],
      async (_topic, payload) => {
        this.ws.emitPaymentUpdate(payload.userId, {
          paymentId: payload.paymentId,
          type: PaymentType.WITHDRAWAL,
          status: PaymentStatus.FAILED,
          amountKes: payload.amountKes,
          timestamp: Date.now(),
        });
      },
    );

    // New in-app notification created — pushes it straight to the bell
    // instead of the client waiting on its next poll interval.
    await this.kafka.subscribe<NotificationCreatedPayload>(
      'gateway-notification-group',
      [KAFKA_TOPICS.NOTIFICATION_CREATED],
      async (_topic, payload) => {
        this.ws.emitNotificationCreated(payload);
      },
    );

    this.logger.log('WebSocket Kafka consumers registered');
  }

  async onModuleDestroy() {
    // KafkaService handles disconnects
  }
}
