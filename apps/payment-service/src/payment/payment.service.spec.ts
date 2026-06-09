import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { PaymentService } from './payment.service';
import { PrismaService } from './prisma.service';
import { MpesaService } from '../mpesa/mpesa.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  payment: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  paymentCallback: {
    create: jest.fn(),
  },
  dailyLimitTracker: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
};

const mockMpesa = {
  normalizePhone: jest.fn((phone: string) => phone.replace(/^0/, '254')),
  stkPush: jest.fn(),
  queryStkPush: jest.fn(),
  b2cTransfer: jest.fn(),
};

const mockKafka = {
  publish: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(),
};

const mockHttp = { post: jest.fn(), get: jest.fn() };

const mockConfig = {
  get: jest.fn((key: string, def?: string) => {
    const map: Record<string, string> = {
      MPESA_CALLBACK_BASE_URL: 'https://callback.example.com',
      AUTH_SERVICE_URL: 'http://localhost:3001',
      WALLET_SERVICE_URL: 'http://localhost:3005',
    };
    return map[key] ?? def ?? 'http://localhost';
  }),
  getOrThrow: jest.fn((key: string) => {
    const map: Record<string, string> = {
      MPESA_CALLBACK_BASE_URL: 'https://callback.example.com',
      INTERNAL_API_KEY: 'test-internal-key',
    };
    if (!(key in map)) throw new Error(`Missing env: ${key}`);
    return map[key];
  }),
};

jest.mock('@org/utils', () => ({
  todayDateString: jest.fn(() => '2026-06-09'),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function axiosOk<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

const makePayment = (overrides = {}) => ({
  id: 'pay-1',
  userId: 'user-1',
  type: 'DEPOSIT',
  status: 'PENDING_MPESA',
  amountKes: 1000,
  phoneNumber: '254712345678',
  checkoutRequestId: 'checkout-req-1',
  conversationId: 'conv-1',
  retryCount: 0,
  mpesaReceiptNumber: null,
  initiatedAt: new Date(),
  confirmedAt: null,
  failureReason: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKafka.publish.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MpesaService, useValue: mockMpesa },
        { provide: KafkaService, useValue: mockKafka },
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  // ── initiateDeposit ─────────────────────────────────────────────────────────

  describe('initiateDeposit', () => {
    const dto = { phone: '0712345678', amountKes: 1000 };

    beforeEach(() => {
      mockPrisma.dailyLimitTracker.findUnique.mockResolvedValue(null); // no prior usage
      mockPrisma.payment.create.mockResolvedValue(makePayment({ status: 'INITIATED' }));
      mockMpesa.stkPush.mockResolvedValue({
        MerchantRequestID: 'merchant-req-1',
        CheckoutRequestID: 'checkout-req-1',
      });
      mockPrisma.payment.update.mockResolvedValue(makePayment());
    });

    it('creates payment record and returns checkoutRequestId', async () => {
      const result = await service.initiateDeposit('user-1', 1, dto as any);
      expect(result).toMatchObject({
        paymentId: expect.any(String),
        status: 'PENDING_MPESA',
        checkoutRequestId: 'checkout-req-1',
      });
    });

    it('calls stkPush with normalized phone', async () => {
      await service.initiateDeposit('user-1', 1, dto as any);
      expect(mockMpesa.normalizePhone).toHaveBeenCalledWith('0712345678');
      expect(mockMpesa.stkPush).toHaveBeenCalledWith(
        expect.stringContaining('254'),
        1000,
        expect.any(String),
        expect.stringContaining('stk'),
      );
    });

    it('marks payment FAILED and rethrows on stkPush error', async () => {
      mockMpesa.stkPush.mockRejectedValue(new Error('Daraja down'));
      await expect(service.initiateDeposit('user-1', 1, dto as any)).rejects.toThrow('Daraja down');
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });

    it('throws BadRequestException when daily deposit limit exceeded', async () => {
      // tier 1 limit = 150_000, already used 140_000, requesting 20_000
      mockPrisma.dailyLimitTracker.findUnique.mockResolvedValue({ deposited: 140_000, withdrawn: 0 });
      await expect(
        service.initiateDeposit('user-1', 1, { phone: '0712345678', amountKes: 20_000 } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── handleStkCallback ───────────────────────────────────────────────────────

  describe('handleStkCallback', () => {
    const successCallback = {
      Body: {
        stkCallback: {
          CheckoutRequestID: 'checkout-req-1',
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'Amount', Value: 1000 },
            ],
          },
        },
      },
    };

    const failCallback = {
      Body: {
        stkCallback: {
          CheckoutRequestID: 'checkout-req-1',
          ResultCode: 1032,
          ResultDesc: 'Request cancelled by user',
          CallbackMetadata: undefined,
        },
      },
    };

    beforeEach(() => {
      mockPrisma.payment.findFirst.mockResolvedValue(makePayment());
      mockPrisma.paymentCallback.create.mockResolvedValue({});
      mockPrisma.payment.update.mockResolvedValue({});
      mockPrisma.dailyLimitTracker.upsert.mockResolvedValue({});
    });

    it('marks payment COMPLETED and publishes DEPOSIT_COMPLETED on success', async () => {
      mockMpesa.queryStkPush.mockResolvedValue({ ResultCode: '0' });
      await service.handleStkCallback(successCallback as any);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', mpesaReceiptNumber: 'NLJ7RT61SV' }) }),
      );
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('deposit-completed'),
        expect.objectContaining({ userId: 'user-1', amountKes: 1000 }),
        'user-1',
      );
    });

    it('marks payment FAILED when STK verification fails', async () => {
      mockMpesa.queryStkPush.mockResolvedValue({ ResultCode: '1' }); // not 0
      await service.handleStkCallback(successCallback as any);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', failureReason: 'Verification failed' }) }),
      );
      expect(mockKafka.publish).not.toHaveBeenCalled();
    });

    it('marks payment FAILED and publishes DEPOSIT_FAILED on non-zero result code', async () => {
      await service.handleStkCallback(failCallback as any);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('deposit-failed'),
        expect.anything(),
        'user-1',
      );
    });

    it('silently returns when no payment found for checkoutRequestId', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      await expect(service.handleStkCallback(successCallback as any)).resolves.toBeUndefined();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    it('skips processing when payment already COMPLETED (idempotency)', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(makePayment({ status: 'COMPLETED' }));
      await service.handleStkCallback(successCallback as any);
      // paymentCallback.create is still called (audit trail), but payment.update is NOT
      expect(mockPrisma.paymentCallback.create).toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });
  });

  // ── initiateWithdrawal ──────────────────────────────────────────────────────

  describe('initiateWithdrawal', () => {
    const dto = { phone: '0712345678', amountKes: 5000, otp: '123456' };

    beforeEach(() => {
      mockHttp.post.mockReturnValue(of(axiosOk({ success: true }))); // OTP verify + reserve
      mockPrisma.dailyLimitTracker.findUnique.mockResolvedValue(null);
      mockPrisma.payment.create.mockResolvedValue(makePayment({ type: 'WITHDRAWAL', status: 'INITIATED' }));
      mockMpesa.b2cTransfer.mockResolvedValue({
        ConversationID: 'conv-1',
        OriginatorConversationID: 'orig-conv-1',
      });
      mockPrisma.payment.update.mockResolvedValue(makePayment({ type: 'WITHDRAWAL', status: 'PROCESSING' }));
    });

    it('throws ForbiddenException when kycTier < 1', async () => {
      await expect(service.initiateWithdrawal('user-1', 0, dto as any)).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when OTP verification fails', async () => {
      mockHttp.post
        .mockReturnValueOnce(throwError(() => ({ response: { data: { message: 'Invalid OTP' } } })));
      await expect(service.initiateWithdrawal('user-1', 1, dto as any)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when wallet reserve fails (insufficient funds)', async () => {
      mockHttp.post
        .mockReturnValueOnce(of(axiosOk({ success: true }))) // OTP ok
        .mockReturnValueOnce(throwError(() => ({ response: { data: { message: 'Insufficient balance' } } }))); // reserve fail
      await expect(service.initiateWithdrawal('user-1', 1, dto as any)).rejects.toThrow(BadRequestException);
    });

    it('creates withdrawal and returns conversationId on success', async () => {
      const result = await service.initiateWithdrawal('user-1', 1, dto as any);
      expect(result).toMatchObject({
        paymentId: expect.any(String),
        status: 'PROCESSING',
        conversationId: 'conv-1',
      });
    });

    it('releases reserved funds when b2cTransfer throws', async () => {
      mockMpesa.b2cTransfer.mockRejectedValue(new Error('B2C failed'));
      await expect(service.initiateWithdrawal('user-1', 1, dto as any)).rejects.toThrow();
      // 3rd post call = release
      expect(mockHttp.post).toHaveBeenCalledWith(
        expect.stringContaining('/release'),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ── handleB2cResult ─────────────────────────────────────────────────────────

  describe('handleB2cResult', () => {
    const successBody = {
      Result: {
        ConversationID: 'conv-1',
        ResultCode: 0,
        ResultDesc: 'Success',
        TransactionID: 'NLJ7RT61SV',
        ResultParameters: {
          ResultParameter: [{ Key: 'TransactionReceipt', Value: 'NLJ7RT61SV' }],
        },
      },
    };

    const failBody = {
      Result: {
        ConversationID: 'conv-1',
        ResultCode: 2001,
        ResultDesc: 'Wrong credentials',
        TransactionID: '',
        ResultParameters: undefined,
      },
    };

    beforeEach(() => {
      mockPrisma.payment.findFirst.mockResolvedValue(makePayment({ type: 'WITHDRAWAL', amountKes: 5000 }));
      mockPrisma.paymentCallback.create.mockResolvedValue({});
      mockPrisma.payment.update.mockResolvedValue({});
      mockPrisma.dailyLimitTracker.upsert.mockResolvedValue({});
      mockHttp.post.mockReturnValue(of(axiosOk({ success: true }))); // debit/release calls
    });

    it('marks payment COMPLETED and debits wallet on success', async () => {
      await service.handleB2cResult(successBody as any);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
      );
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('withdrawal-completed'),
        expect.anything(),
        'user-1',
      );
    });

    it('marks payment FAILED and releases wallet on failure', async () => {
      await service.handleB2cResult(failBody as any);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('withdrawal-failed'),
        expect.anything(),
        'user-1',
      );
    });

    it('silently returns when no payment found', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      await expect(service.handleB2cResult(successBody as any)).resolves.toBeUndefined();
    });
  });

  // ── handleB2cTimeout ────────────────────────────────────────────────────────

  describe('handleB2cTimeout', () => {
    const body = { Result: { ConversationID: 'conv-1' } };

    beforeEach(() => {
      mockPrisma.payment.findFirst.mockResolvedValue(makePayment({ type: 'WITHDRAWAL', retryCount: 0 }));
      mockPrisma.paymentCallback.create.mockResolvedValue({});
      mockPrisma.payment.update.mockResolvedValue({});
      mockHttp.post.mockReturnValue(of(axiosOk({ success: true })));
    });

    it('retries B2C when retryCount < 1', async () => {
      mockMpesa.b2cTransfer.mockResolvedValue({ ConversationID: 'conv-2', OriginatorConversationID: 'orig-2' });
      await service.handleB2cTimeout(body as any);
      expect(mockMpesa.b2cTransfer).toHaveBeenCalled();
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ retryCount: { increment: 1 } }) }),
      );
    });

    it('marks payment FAILED when retryCount >= 1', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(makePayment({ retryCount: 1 }));
      await service.handleB2cTimeout(body as any);
      expect(mockMpesa.b2cTransfer).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });
  });

  // ── getPaymentStatus ────────────────────────────────────────────────────────

  describe('getPaymentStatus', () => {
    it('returns payment status for owner', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(makePayment());
      const result = await service.getPaymentStatus('pay-1', 'user-1');
      expect(result).toMatchObject({ paymentId: 'pay-1', type: 'DEPOSIT', status: 'PENDING_MPESA' });
    });

    it('throws NotFoundException when payment not found', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(null);
      await expect(service.getPaymentStatus('bad-id', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when payment belongs to different user', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(makePayment({ userId: 'other-user' }));
      await expect(service.getPaymentStatus('pay-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });
  });
});
