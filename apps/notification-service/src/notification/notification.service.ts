import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PushService } from './push.service';
import type {
  TradeConfirmedPayload,
  MarketSettledPayload,
  DepositCompletedPayload,
  WithdrawalCompletedPayload,
  WithdrawalFailedPayload,
} from '@org/types';
import { NotificationChannel, NotificationType } from '@org/types';
import { NotificationStatus } from '.prisma/notification-client';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  // ─── Kafka event handlers ──────────────────────────────────────────────────

  async onTradeConfirmed(payload: TradeConfirmedPayload): Promise<void> {
    const { userId, outcome, sharesCount, amountKes, marketTitle } = payload;

    const body = `You bought ${sharesCount} ${outcome} share${sharesCount !== 1 ? 's' : ''} on "${marketTitle}" for KES ${amountKes.toLocaleString()}`;

    await this.createAndSend(userId, NotificationType.TRADE_CONFIRMED, 'Trade Confirmed', body);
  }

  async onMarketSettled(payload: MarketSettledPayload): Promise<void> {
    const { userId, outcome, payoutKes, marketTitle, winningOutcome } = payload;

    const won = outcome === winningOutcome;
    const title = won ? 'You Won!' : 'Market Resolved';
    const body = won
      ? `Congratulations! You won KES ${payoutKes.toLocaleString()} on "${marketTitle}"`
      : `The market "${marketTitle}" resolved as ${winningOutcome}. Better luck next time!`;

    await this.createAndSend(userId, NotificationType.TRADE_SETTLED, title, body);
  }

  async onDepositCompleted(payload: DepositCompletedPayload): Promise<void> {
    const { userId, amountKes, mpesaReceiptNumber } = payload;

    const body = `Your deposit of KES ${amountKes.toLocaleString()} (M-Pesa ref: ${mpesaReceiptNumber}) has been received.`;

    await this.createAndSend(userId, NotificationType.DEPOSIT_CONFIRMED, 'Deposit Received', body);
  }

  async onWithdrawalCompleted(payload: WithdrawalCompletedPayload): Promise<void> {
    const { userId, amountKes, phone } = payload;

    const body = `KES ${amountKes.toLocaleString()} has been sent to ${phone} via M-Pesa.`;

    await this.createAndSend(userId, NotificationType.WITHDRAWAL_COMPLETED, 'Withdrawal Sent', body);
  }

  async onWithdrawalFailed(payload: WithdrawalFailedPayload): Promise<void> {
    const { userId, amountKes, reason } = payload;

    const body = `Your withdrawal of KES ${amountKes.toLocaleString()} failed. ${reason ?? 'Please try again.'}`;

    await this.createAndSend(userId, NotificationType.WITHDRAWAL_FAILED, 'Withdrawal Failed', body);
  }

  // ─── In-app notification reads ─────────────────────────────────────────────

  async getForUser(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, channel: NotificationChannel.IN_APP },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId, channel: NotificationChannel.IN_APP } }),
      this.prisma.notification.count({
        where: { userId, channel: NotificationChannel.IN_APP, status: NotificationStatus.SENT },
      }),
    ]);

    return { notifications, total, unreadCount, page, limit };
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { status: NotificationStatus.READ, readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, channel: NotificationChannel.IN_APP, status: NotificationStatus.SENT },
      data: { status: NotificationStatus.READ, readAt: new Date() },
    });
  }

  // ─── Device token management ───────────────────────────────────────────────

  async registerDeviceToken(userId: string, token: string, platform: string): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  async removeDeviceToken(token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async createAndSend(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
  ): Promise<void> {
    // Persist in-app notification
    await this.prisma.notification.create({
      data: {
        userId,
        type,
        channel: NotificationChannel.IN_APP,
        title,
        body,
        status: NotificationStatus.SENT,
        sentAt: new Date(),
      },
    });

    // Get user's push tokens and phone for SMS (fetched from user-service or stored here)
    // We'll dispatch SMS + push in parallel, failures are non-fatal
    await Promise.allSettled([
      this.sendSmsToUser(userId, body),
      this.sendPushToUser(userId, title, body),
    ]);
  }

  private async sendSmsToUser(userId: string, message: string): Promise<void> {
    // Look up device tokens table for phone — in a real system we'd call user-service
    // For now, we skip SMS from here; SMS is dispatched by payment-service directly
    // This keeps us from duplicating the message
    this.logger.debug(`SMS for user ${userId} handled upstream`);
  }

  private async sendPushToUser(userId: string, title: string, body: string): Promise<void> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (!tokens.length) return;

    await this.push.sendMulticast(
      tokens.map((t) => t.token),
      title,
      body,
    );
  }
}
