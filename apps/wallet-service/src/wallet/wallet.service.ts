import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import {
  LedgerType,
  Direction,
  MarketSettledPayload,
  DepositCompletedPayload,
} from '@org/types';
import { generateSettlementId } from '@org/utils';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  // ─── Get wallet ───────────────────────────────────────────────────────────────

  async getWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const available = Number(wallet.balance) - Number(wallet.reservedBalance);
    return {
      userId: wallet.userId,
      balance: Number(wallet.balance),
      reservedBalance: Number(wallet.reservedBalance),
      availableBalance: available,
      lifetimeDeposit: Number(wallet.lifetimeDeposit),
      lifetimeWithdraw: Number(wallet.lifetimeWithdraw),
      lifetimePayout: Number(wallet.lifetimePayout),
      currency: wallet.currency,
    };
  }

  // ─── Get ledger ───────────────────────────────────────────────────────────────

  async getLedger(userId: string, page = 1, limit = 20) {
    const wallet = await this.ensureWallet(userId);
    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { walletId: wallet.id },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.ledgerEntry.count({ where: { walletId: wallet.id } }),
    ]);

    return { data: entries, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Internal: Credit (deposit, payout, refund) ───────────────────────────────

  async credit(
    userId: string,
    amount: number,
    type: LedgerType,
    referenceId: string,
    referenceType: string,
    description?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + amount;

      await tx.wallet.update({
        where: { userId, version: wallet.version },
        data: {
          balance: balanceAfter,
          version: { increment: 1 },
          lifetimeDeposit: type === LedgerType.DEPOSIT
            ? { increment: amount }
            : undefined,
          lifetimePayout: type === LedgerType.PAYOUT
            ? { increment: amount }
            : undefined,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId,
          type,
          direction: Direction.CREDIT,
          amount,
          balanceBefore,
          balanceAfter,
          referenceId,
          referenceType,
          description,
        },
      });

      return { balanceBefore, balanceAfter, amount };
    });
  }

  // ─── Internal: Debit ──────────────────────────────────────────────────────────

  async debit(
    userId: string,
    amount: number,
    type: LedgerType,
    referenceId: string,
    referenceType: string,
    description?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const available = Number(wallet.balance) - Number(wallet.reservedBalance);
      if (available < amount) {
        throw new BadRequestException(
          `Insufficient balance. Available: KES ${available.toFixed(2)}, Required: KES ${amount.toFixed(2)}`,
        );
      }

      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore - amount;

      await tx.wallet.update({
        where: { userId, version: wallet.version },
        data: {
          balance: balanceAfter,
          version: { increment: 1 },
          lifetimeWithdraw: type === LedgerType.WITHDRAWAL
            ? { increment: amount }
            : undefined,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId,
          type,
          direction: Direction.DEBIT,
          amount,
          balanceBefore,
          balanceAfter,
          referenceId,
          referenceType,
          description,
        },
      });

      return { balanceBefore, balanceAfter, amount };
    });
  }

  // ─── Internal: Reserve (before trade) ────────────────────────────────────────

  async reserve(userId: string, amount: number, referenceId: string) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const available = Number(wallet.balance) - Number(wallet.reservedBalance);
      if (available < amount) {
        throw new BadRequestException(
          `Insufficient balance. Available: KES ${available.toFixed(2)}, Required: KES ${amount.toFixed(2)}`,
        );
      }

      await tx.wallet.update({
        where: { userId, version: wallet.version },
        data: {
          reservedBalance: { increment: amount },
          version: { increment: 1 },
        },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId,
          type: LedgerType.TRADE_RESERVE,
          direction: Direction.DEBIT,
          amount,
          balanceBefore: Number(wallet.balance),
          balanceAfter: Number(wallet.balance),
          referenceId,
          referenceType: 'TRADE',
          description: 'Funds reserved for trade',
        },
      });
    });
  }

  // ─── Internal: Release reserve ────────────────────────────────────────────────

  async releaseReserve(userId: string, amount: number, referenceId: string) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) return;

      await tx.wallet.update({
        where: { userId },
        data: { reservedBalance: { decrement: amount } },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId,
          type: LedgerType.TRADE_RELEASE,
          direction: Direction.CREDIT,
          amount,
          balanceBefore: Number(wallet.balance),
          balanceAfter: Number(wallet.balance),
          referenceId,
          referenceType: 'TRADE',
          description: 'Reserved funds released',
        },
      });
    });
  }

  // ─── Kafka: settle market (batch payouts) ─────────────────────────────────────

  async settleMarket(payload: MarketSettledPayload) {
    const { marketId, userId, outcome, payoutKes } = payload;

    const settlementId = generateSettlementId(marketId, userId, outcome);

    // Idempotency: check if already settled
    const existing = await this.prisma.ledgerEntry.findFirst({
      where: { referenceId: settlementId, referenceType: 'PAYOUT' },
    });
    if (existing) {
      this.logger.warn(`Duplicate settlement skipped: ${settlementId}`);
      return;
    }

    try {
      await this.ensureWallet(userId);

      await this.prisma.$transaction(async (tx) => {
        const w = await tx.wallet.findUniqueOrThrow({ where: { userId } });

        await tx.wallet.update({
          where: { userId },
          data: {
            balance: { increment: payoutKes },
            lifetimePayout: { increment: payoutKes },
          },
        });

        await tx.ledgerEntry.create({
          data: {
            walletId: w.id,
            userId,
            type: LedgerType.PAYOUT,
            direction: Direction.CREDIT,
            amount: payoutKes,
            balanceBefore: Number(w.balance),
            balanceAfter: Number(w.balance) + payoutKes,
            referenceId: settlementId,
            referenceType: 'PAYOUT',
            description: `Payout for market ${marketId} — ${outcome}`,
          },
        });
      });

      this.logger.log(`Settlement credited: user=${userId} market=${marketId} payout=${payoutKes}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Settlement failed for user ${userId}: ${msg}`);
    }
  }

  // ─── Kafka: deposit completed ─────────────────────────────────────────────────

  async handleDepositCompleted(payload: DepositCompletedPayload) {
    await this.ensureWallet(payload.userId);
    await this.credit(
      payload.userId,
      payload.amountKes,
      LedgerType.DEPOSIT,
      payload.paymentId,
      'DEPOSIT',
      `M-Pesa deposit ${payload.mpesaReceiptNumber}`,
    );

    await this.kafka.publish(KAFKA_TOPICS.NOTIFICATION_SEND_SMS, {
      userId: payload.userId,
      phone: '',
      message: `KES ${payload.amountKes.toFixed(2)} deposited to your PredictMarket wallet. Ref: ${payload.mpesaReceiptNumber}`,
      notificationType: 'DEPOSIT_CONFIRMED',
    });

    this.logger.log(`Deposit credited: user=${payload.userId} amount=${payload.amountKes}`);
  }

  // ─── Create wallet (triggered by user registration) ───────────────────────────

  async createWallet(userId: string) {
    const existing = await this.prisma.wallet.findUnique({ where: { userId } });
    if (existing) return existing;

    return this.prisma.wallet.create({
      data: { userId, balance: 0, reservedBalance: 0 },
    });
  }

  // ─── Kafka consumers ──────────────────────────────────────────────────────────

  async startKafkaConsumers() {
    await this.kafka.subscribe(
      'wallet-service-registration-group',
      [KAFKA_TOPICS.AUTH_USER_REGISTERED],
      async (_topic, payload: any) => {
        await this.createWallet(payload.userId);
      },
    );

    await this.kafka.subscribe<MarketSettledPayload>(
      'wallet-service-settlement-group',
      [KAFKA_TOPICS.TRADING_MARKET_SETTLED],
      async (_topic, payload) => {
        await this.settleMarket(payload);
      },
    );

    await this.kafka.subscribe<DepositCompletedPayload>(
      'wallet-service-deposit-group',
      [KAFKA_TOPICS.PAYMENT_DEPOSIT_COMPLETED],
      async (_topic, payload) => {
        await this.handleDepositCompleted(payload);
      },
    );

    await this.kafka.subscribe(
      'wallet-service-credit-group',
      [KAFKA_TOPICS.WALLET_CREDITED],
      async (_topic, payload: any) => {
        await this.credit(
          payload.userId,
          payload.amount,
          LedgerType.REFUND,
          payload.referenceId,
          payload.referenceType,
          payload.description,
        );
      },
    );
  }

  private async ensureWallet(userId: string) {
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: { userId, balance: 0, reservedBalance: 0 },
      });
    }
    return wallet;
  }
}
