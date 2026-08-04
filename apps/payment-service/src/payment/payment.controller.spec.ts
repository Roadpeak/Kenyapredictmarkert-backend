import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPaymentService = {
  handleStkCallback: jest.fn().mockResolvedValue(undefined),
  handleB2cResult: jest.fn().mockResolvedValue(undefined),
  handleB2cTimeout: jest.fn().mockResolvedValue(undefined),
};

function makeConfig(values: Record<string, string | undefined> = {}) {
  return { get: jest.fn((key: string) => values[key]) };
}

async function buildController(config: ReturnType<typeof makeConfig>) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [PaymentController],
    providers: [
      { provide: PaymentService, useValue: mockPaymentService },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return module.get<PaymentController>(PaymentController);
}

const STK_CALLBACK_BODY = {
  Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'c', ResultCode: 0, ResultDesc: 'ok' } },
} as never;

describe('PaymentController — M-Pesa callback IP validation', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.clearAllMocks();
  });

  it('skips IP validation outside production', async () => {
    process.env.NODE_ENV = 'development';
    const controller = await buildController(makeConfig());

    await expect(controller.stkCallback(STK_CALLBACK_BODY, '1.2.3.4')).resolves.toBeUndefined();
    expect(mockPaymentService.handleStkCallback).toHaveBeenCalled();
  });

  it('accepts a request from a whitelisted Safaricom IP in production', async () => {
    process.env.NODE_ENV = 'production';
    const controller = await buildController(makeConfig());

    await expect(
      controller.stkCallback(STK_CALLBACK_BODY, '196.201.214.200'),
    ).resolves.toBeUndefined();
    expect(mockPaymentService.handleStkCallback).toHaveBeenCalled();
  });

  it('rejects a non-whitelisted IP in production with 403, not a generic 500', async () => {
    process.env.NODE_ENV = 'production';
    const controller = await buildController(makeConfig());

    // validateSafaricomIp throws synchronously before the (async) service
    // call, so this rejects the promise chain but the throw itself is sync.
    expect(() => controller.stkCallback(STK_CALLBACK_BODY, '1.2.3.4')).toThrow(
      ForbiddenException,
    );
    expect(mockPaymentService.handleStkCallback).not.toHaveBeenCalled();
  });

  it('normalizes an IPv4-mapped IPv6 address before checking the allowlist', async () => {
    // Express reports ::ffff:x.x.x.x on some socket configurations — without
    // stripping the prefix, every real Safaricom callback would 403.
    process.env.NODE_ENV = 'production';
    const controller = await buildController(makeConfig());

    await expect(
      controller.stkCallback(STK_CALLBACK_BODY, '::ffff:196.201.214.200'),
    ).resolves.toBeUndefined();
    expect(mockPaymentService.handleStkCallback).toHaveBeenCalled();
  });

  it('uses MPESA_CALLBACK_IPS to override the default allowlist when set', async () => {
    process.env.NODE_ENV = 'production';
    const controller = await buildController(makeConfig({ MPESA_CALLBACK_IPS: '10.0.0.1, 10.0.0.2' }));

    // A real Safaricom IP is now rejected because the override replaced it.
    expect(() => controller.stkCallback(STK_CALLBACK_BODY, '196.201.214.200')).toThrow(
      ForbiddenException,
    );
    // The overridden IP is accepted.
    await expect(controller.stkCallback(STK_CALLBACK_BODY, '10.0.0.2')).resolves.toBeUndefined();
  });

  it('applies the same IP check to all three callback routes', async () => {
    process.env.NODE_ENV = 'production';
    const controller = await buildController(makeConfig());

    expect(() => controller.b2cResultCallback({ Result: {} } as never, '1.2.3.4')).toThrow(
      ForbiddenException,
    );
    expect(() => controller.b2cTimeoutCallback({ Result: {} } as never, '1.2.3.4')).toThrow(
      ForbiddenException,
    );
  });
});
