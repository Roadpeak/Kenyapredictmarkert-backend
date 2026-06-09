import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from './prisma.service';
import { MpesaService } from '../mpesa/mpesa.service';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { todayDateString } from '@org/utils';
import {
  StkCallback,
  B2cResult,
  B2cTimeout,
  MPESA_SUCCESS_CODE,
  MPESA_ERROR_CODES,
} from '../mpesa/mpesa.types';
import { InitiateDepositDto, InitiateWithdrawalDto } from './payment.dto';

// Daily limits per KYC tier (KES)
const DAILY_LIMITS = {
  deposit: { 0: 50_000, 1: 150_000, 2: 300_000 },
  withdrawal: { 0: 0, 1: 70_000, 2: 150_000 },
} as const;

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mpesa: MpesaService,
    private readonly kafka: KafkaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  // ─── Initiate Deposit (STK Push) ─────────────────────────────────────────────

  async initiateDeposit(userId: string, kycTier: number, dto: InitiateDepositDto) {
    const phone = this.mpesa.normalizePhone(dto.phone);

    // Enforce daily deposit limit
    await this.checkDailyLimit(userId, 'deposit', dto.amountKes, kycTier);

    const idempotencyKey = uuidv4();
    const callbackUrl = `${this.config.getOrThrow('MPESA_CALLBACK_BASE_URL')}/api/callbacks/mpesa/stk`;

    // Create payment record BEFORE calling Daraja (so we can match the callback)
    const payment = await this.prisma.payment.create({
      data: {
        userId,
        type: 'DEPOSIT',
        status: 'INITIATED',
        amountKes: dto.amountKes,
        phoneNumber: phone,
        idempotencyKey,
        metadata: { kycTier },
      },
    });

    try {
      const stkResponse = await this.mpesa.stkPush(
        phone,
        dto.amountKes,
        payment.id.slice(0, 12), // AccountReference max 12 chars
        callbackUrl,
      );

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'PENDING_MPESA',
          merchantRequestId: stkResponse.MerchantRequestID,
          checkoutRequestId: stkResponse.CheckoutRequestID,
        },
      });

      await this.kafka.publish(KAFKA_TOPICS.PAYMENT_DEPOSIT_INITIATED, {
        paymentId: payment.id,
        userId,
        amountKes: dto.amountKes,
        phone,
      });

      return {
        paymentId: payment.id,
        status: 'PENDING_MPESA',
        message: `Enter your M-Pesa PIN on ${dto.phone} to complete the deposit`,
        checkoutRequestId: stkResponse.CheckoutRequestID,
      };
    } catch (err: unknown) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: String(err) },
      });
      throw err;
    }
  }

  // ─── STK Callback (from Safaricom) ───────────────────────────────────────────

  async handleStkCallback(body: StkCallback) {
    const callback = body.Body.stkCallback;

    this.logger.log(
      `STK callback received: checkoutId=${callback.CheckoutRequestID} resultCode=${callback.ResultCode}`,
    );

    // Find payment by checkoutRequestId
    const payment = await this.prisma.payment.findFirst({
      where: { checkoutRequestId: callback.CheckoutRequestID },
    });

    if (!payment) {
      this.logger.warn(`No payment found for checkoutId=${callback.CheckoutRequestID}`);
      return;
    }

    // Store raw callback — never lose this
    await this.prisma.paymentCallback.create({
      data: {
        paymentId: payment.id,
        rawPayload: body as object,
      },
    });

    // Idempotency — if already processed, skip
    if (payment.status === 'COMPLETED' || payment.status === 'FAILED') {
      this.logger.warn(`Payment ${payment.id} already processed, ignoring duplicate callback`);
      return;
    }

    if (callback.ResultCode === MPESA_SUCCESS_CODE) {
      // CRITICAL: Verify independently via QuerySTKPush before crediting
      const verified = await this.verifyStkPayment(callback.CheckoutRequestID);

      if (!verified) {
        this.logger.error(`STK verification failed for payment ${payment.id}`);
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failedAt: new Date(), failureReason: 'Verification failed' },
        });
        return;
      }

      // Extract M-Pesa receipt number from callback metadata
      const receiptItem = callback.CallbackMetadata?.Item.find(
        (i) => i.Name === 'MpesaReceiptNumber',
      );
      const mpesaReceiptNumber = receiptItem?.Value?.toString() ?? '';

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'COMPLETED',
          mpesaReceiptNumber,
          confirmedAt: new Date(),
        },
      });

      // Update daily limit tracker
      await this.incrementDailyLimit(payment.userId, 'deposit', Number(payment.amountKes));

      // Publish to wallet-service for crediting
      await this.kafka.publish(
        KAFKA_TOPICS.PAYMENT_DEPOSIT_COMPLETED,
        {
          paymentId: payment.id,
          userId: payment.userId,
          amountKes: Number(payment.amountKes),
          mpesaReceiptNumber,
        },
        payment.userId,
      );

      this.logger.log(
        `Deposit completed: userId=${payment.userId} amount=${payment.amountKes} receipt=${mpesaReceiptNumber}`,
      );
    } else {
      const reason = MPESA_ERROR_CODES[callback.ResultCode] ?? callback.ResultDesc;

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
      });

      await this.kafka.publish(
        KAFKA_TOPICS.PAYMENT_DEPOSIT_FAILED,
        {
          paymentId: payment.id,
          userId: payment.userId,
          amountKes: Number(payment.amountKes),
          reason,
        },
        payment.userId,
      );

      this.logger.warn(`Deposit failed: paymentId=${payment.id} reason=${reason}`);
    }
  }

  // ─── Initiate Withdrawal (B2C) ────────────────────────────────────────────────

  async initiateWithdrawal(userId: string, kycTier: number, dto: InitiateWithdrawalDto) {
    if (kycTier < 1) {
      throw new ForbiddenException(
        'Identity verification (KYC Tier 1) is required before withdrawing. Please submit your National ID.',
      );
    }

    const phone = this.mpesa.normalizePhone(dto.phone);

    // Verify OTP (withdrawal_confirm purpose — must be pre-requested)
    await this.verifyWithdrawalOtp(userId, dto.otp);

    // Enforce daily withdrawal limit
    await this.checkDailyLimit(userId, 'withdrawal', dto.amountKes, kycTier);

    // Reserve funds in wallet-service BEFORE calling B2C
    await this.reserveWalletFunds(userId, dto.amountKes);

    const idempotencyKey = uuidv4();
    const resultUrl = `${this.config.getOrThrow('MPESA_CALLBACK_BASE_URL')}/api/callbacks/mpesa/b2c/result`;
    const timeoutUrl = `${this.config.getOrThrow('MPESA_CALLBACK_BASE_URL')}/api/callbacks/mpesa/b2c/timeout`;

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        type: 'WITHDRAWAL',
        status: 'INITIATED',
        amountKes: dto.amountKes,
        phoneNumber: phone,
        idempotencyKey,
      },
    });

    try {
      const b2cResponse = await this.mpesa.b2cTransfer(
        phone,
        dto.amountKes,
        resultUrl,
        timeoutUrl,
        `PredictMarket withdrawal ${payment.id.slice(0, 20)}`,
      );

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'PROCESSING',
          conversationId: b2cResponse.ConversationID,
          originatorConvId: b2cResponse.OriginatorConversationID,
        },
      });

      await this.kafka.publish(KAFKA_TOPICS.PAYMENT_WITHDRAWAL_INITIATED, {
        paymentId: payment.id,
        userId,
        amountKes: dto.amountKes,
        phone,
      });

      return {
        paymentId: payment.id,
        status: 'PROCESSING',
        message: 'Withdrawal initiated. Funds will arrive on your M-Pesa shortly.',
        conversationId: b2cResponse.ConversationID,
      };
    } catch (err: unknown) {
      // Release the reserved funds on B2C initiation failure
      await this.releaseWalletFunds(userId, dto.amountKes);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: String(err) },
      });
      throw err;
    }
  }

  // ─── B2C Result Callback ──────────────────────────────────────────────────────

  async handleB2cResult(body: B2cResult) {
    const result = body.Result;

    this.logger.log(
      `B2C result received: convId=${result.ConversationID} resultCode=${result.ResultCode}`,
    );

    const payment = await this.prisma.payment.findFirst({
      where: { conversationId: result.ConversationID },
    });

    if (!payment) {
      this.logger.warn(`No payment found for conversationId=${result.ConversationID}`);
      return;
    }

    await this.prisma.paymentCallback.create({
      data: {
        paymentId: payment.id,
        rawPayload: body as object,
      },
    });

    if (payment.status === 'COMPLETED' || payment.status === 'FAILED') {
      this.logger.warn(`Payment ${payment.id} already processed`);
      return;
    }

    if (result.ResultCode === MPESA_SUCCESS_CODE) {
      const receiptParam = result.ResultParameters?.ResultParameter.find(
        (p) => p.Key === 'TransactionReceipt',
      );
      const mpesaReceiptNumber = receiptParam?.Value?.toString() ?? result.TransactionID;

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'COMPLETED',
          mpesaReceiptNumber,
          confirmedAt: new Date(),
        },
      });

      // Debit wallet — reserve becomes permanent debit
      await this.debitWalletFunds(
        payment.userId,
        Number(payment.amountKes),
        payment.id,
        mpesaReceiptNumber,
      );

      await this.incrementDailyLimit(payment.userId, 'withdrawal', Number(payment.amountKes));

      await this.kafka.publish(
        KAFKA_TOPICS.PAYMENT_WITHDRAWAL_COMPLETED,
        {
          paymentId: payment.id,
          userId: payment.userId,
          amountKes: Number(payment.amountKes),
          mpesaReceiptNumber,
        },
        payment.userId,
      );

      this.logger.log(
        `Withdrawal completed: userId=${payment.userId} amount=${payment.amountKes} receipt=${mpesaReceiptNumber}`,
      );
    } else {
      const reason = MPESA_ERROR_CODES[result.ResultCode] ?? result.ResultDesc;

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
      });

      // Release reserved funds back to available balance
      await this.releaseWalletFunds(payment.userId, Number(payment.amountKes));

      await this.kafka.publish(
        KAFKA_TOPICS.PAYMENT_WITHDRAWAL_FAILED,
        {
          paymentId: payment.id,
          userId: payment.userId,
          amountKes: Number(payment.amountKes),
          reason,
        },
        payment.userId,
      );

      this.logger.warn(`Withdrawal failed: paymentId=${payment.id} reason=${reason}`);
    }
  }

  // ─── B2C Timeout ─────────────────────────────────────────────────────────────

  async handleB2cTimeout(body: B2cTimeout) {
    const result = body.Result;
    this.logger.warn(`B2C timeout: convId=${result.ConversationID}`);

    const payment = await this.prisma.payment.findFirst({
      where: { conversationId: result.ConversationID },
    });

    if (!payment) return;

    await this.prisma.paymentCallback.create({
      data: { paymentId: payment.id, rawPayload: body as object },
    });

    // Retry once if this is the first timeout
    if (payment.retryCount < 1) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { retryCount: { increment: 1 }, lastRetryAt: new Date() },
      });

      this.logger.log(`Retrying B2C for payment ${payment.id}`);

      const resultUrl = `${this.config.getOrThrow('MPESA_CALLBACK_BASE_URL')}/api/callbacks/mpesa/b2c/result`;
      const timeoutUrl = `${this.config.getOrThrow('MPESA_CALLBACK_BASE_URL')}/api/callbacks/mpesa/b2c/timeout`;

      try {
        const b2cResponse = await this.mpesa.b2cTransfer(
          payment.phoneNumber,
          Number(payment.amountKes),
          resultUrl,
          timeoutUrl,
          `PredictMarket withdrawal retry ${payment.id.slice(0, 16)}`,
        );

        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { conversationId: b2cResponse.ConversationID, status: 'PROCESSING' },
        });
      } catch {
        await this.markWithdrawalFailed(payment.id, payment.userId, Number(payment.amountKes), 'Timeout after retry');
      }
    } else {
      await this.markWithdrawalFailed(payment.id, payment.userId, Number(payment.amountKes), 'B2C timeout exceeded');
    }
  }

  // ─── Get payment status ───────────────────────────────────────────────────────

  async getPaymentStatus(paymentId: string, userId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.userId !== userId) throw new ForbiddenException();

    return {
      paymentId: payment.id,
      type: payment.type,
      status: payment.status,
      amountKes: Number(payment.amountKes),
      mpesaReceiptNumber: payment.mpesaReceiptNumber,
      initiatedAt: payment.initiatedAt,
      confirmedAt: payment.confirmedAt,
      failureReason: payment.failureReason,
    };
  }

  async getDepositHistory(userId: string, page = 1, limit = 20) {
    return this.getPaymentHistory(userId, 'DEPOSIT', page, limit);
  }

  async getWithdrawalHistory(userId: string, page = 1, limit = 20) {
    return this.getPaymentHistory(userId, 'WITHDRAWAL', page, limit);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async getPaymentHistory(userId: string, type: 'DEPOSIT' | 'WITHDRAWAL', page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { userId, type },
        skip, take: limit,
        orderBy: { initiatedAt: 'desc' },
        select: {
          id: true, type: true, status: true, amountKes: true,
          mpesaReceiptNumber: true, initiatedAt: true, confirmedAt: true,
          failureReason: true, phoneNumber: true,
        },
      }),
      this.prisma.payment.count({ where: { userId, type } }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  private async checkDailyLimit(
    userId: string,
    type: 'deposit' | 'withdrawal',
    amount: number,
    kycTier: number,
  ) {
    const tier = Math.min(kycTier, 2) as 0 | 1 | 2;
    const limit = DAILY_LIMITS[type][tier];

    if (limit === 0) {
      throw new ForbiddenException(
        'Identity verification required before withdrawals. Submit your National ID.',
      );
    }

    const today = todayDateString();
    const tracker = await this.prisma.dailyLimitTracker.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    const used = Number(type === 'deposit' ? tracker?.deposited ?? 0 : tracker?.withdrawn ?? 0);

    if (used + amount > limit) {
      throw new BadRequestException(
        `Daily ${type} limit of KES ${limit.toLocaleString()} exceeded. Used: KES ${used.toLocaleString()}, Requested: KES ${amount.toLocaleString()}`,
      );
    }
  }

  private async incrementDailyLimit(userId: string, type: 'deposit' | 'withdrawal', amount: number) {
    const today = todayDateString();
    await this.prisma.dailyLimitTracker.upsert({
      where: { userId_date: { userId, date: today } },
      update: {
        deposited: type === 'deposit' ? { increment: amount } : undefined,
        withdrawn: type === 'withdrawal' ? { increment: amount } : undefined,
      },
      create: {
        userId,
        date: today,
        deposited: type === 'deposit' ? amount : 0,
        withdrawn: type === 'withdrawal' ? amount : 0,
      },
    });
  }

  private async verifyStkPayment(checkoutRequestId: string): Promise<boolean> {
    try {
      const result = await this.mpesa.queryStkPush(checkoutRequestId);
      return result.ResultCode === '0';
    } catch {
      return false;
    }
  }

  private async verifyWithdrawalOtp(userId: string, otp: string) {
    // Delegate OTP check to auth-service
    const authUrl = this.config.get('AUTH_SERVICE_URL', 'http://localhost:3001');
    try {
      await firstValueFrom(
        this.http.post(`${authUrl}/api/internal/verify-otp`, {
          userId,
          otp,
          purpose: 'WITHDRAWAL_CONFIRM',
        }),
      );
    } catch {
      throw new BadRequestException('Invalid or expired OTP');
    }
  }

  private async reserveWalletFunds(userId: string, amount: number) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.getOrThrow('INTERNAL_API_KEY');
    try {
      await firstValueFrom(
        this.http.post(
          `${walletUrl}/api/internal/wallet/reserve`,
          { userId, amount, referenceId: `withdrawal:${userId}:${Date.now()}` },
          { headers: { 'x-internal-key': internalKey } },
        ),
      );
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Insufficient balance';
      throw new BadRequestException(msg);
    }
  }

  private async releaseWalletFunds(userId: string, amount: number) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.getOrThrow('INTERNAL_API_KEY');
    try {
      await firstValueFrom(
        this.http.post(
          `${walletUrl}/api/internal/wallet/release`,
          { userId, amount, referenceId: `withdrawal:${userId}` },
          { headers: { 'x-internal-key': internalKey } },
        ),
      );
    } catch (err: unknown) {
      this.logger.error(`Failed to release wallet reserve for user ${userId}: ${err}`);
    }
  }

  private async debitWalletFunds(userId: string, amount: number, paymentId: string, receipt: string) {
    const walletUrl = this.config.get('WALLET_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.getOrThrow('INTERNAL_API_KEY');
    await firstValueFrom(
      this.http.post(
        `${walletUrl}/api/internal/wallet/debit`,
        {
          userId,
          amount,
          referenceId: paymentId,
          referenceType: 'WITHDRAWAL',
          description: `M-Pesa withdrawal ${receipt}`,
        },
        { headers: { 'x-internal-key': internalKey } },
      ),
    );
  }

  private async markWithdrawalFailed(paymentId: string, userId: string, amount: number, reason: string) {
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
    });
    await this.releaseWalletFunds(userId, amount);
    await this.kafka.publish(
      KAFKA_TOPICS.PAYMENT_WITHDRAWAL_FAILED,
      { paymentId, userId, amountKes: amount, reason },
      userId,
    );
  }
}
