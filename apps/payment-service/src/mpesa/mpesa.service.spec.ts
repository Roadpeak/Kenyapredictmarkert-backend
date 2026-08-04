import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import { of, throwError } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import { generateKeyPairSync, privateDecrypt, constants } from 'crypto';
import { MpesaService } from './mpesa.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
};

const mockHttp = { get: jest.fn(), post: jest.fn() };

// A real keypair so the SecurityCredential test proves an actual round-trip,
// not just "some string came out".
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const CONFIG: Record<string, string> = {
  MPESA_CONSUMER_KEY: 'consumer-key',
  MPESA_CONSUMER_SECRET: 'consumer-secret',
  MPESA_ENVIRONMENT: 'sandbox',
  MPESA_SHORT_CODE: '174379',
  MPESA_PASSKEY: 'test-passkey',
  MPESA_B2C_INITIATOR_NAME: 'testapi',
  MPESA_B2C_INITIATOR_PASSWORD: 'InitiatorPass123',
  MPESA_B2C_CERTIFICATE: publicKey,
};

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values = { ...CONFIG, ...overrides };
  return {
    get: jest.fn((key: string, def?: string) => values[key] ?? def),
    getOrThrow: jest.fn((key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`Missing config: ${key}`);
      return v;
    }),
  };
}

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

async function buildService(config: ReturnType<typeof makeConfig>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      MpesaService,
      { provide: ConfigService, useValue: config },
      { provide: HttpService, useValue: mockHttp },
      { provide: getRedisConnectionToken(), useValue: mockRedis },
    ],
  }).compile();
  return module.get<MpesaService>(MpesaService);
}

describe('MpesaService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Access token ────────────────────────────────────────────────────────────

  describe('getAccessToken', () => {
    it('fetches and caches a fresh token when none is cached', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(of(axiosResponse({ access_token: 'tok-1', expires_in: '3599' })));

      const token = await service.getAccessToken();

      expect(token).toBe('tok-1');
      expect(mockHttp.get).toHaveBeenCalledWith(
        expect.stringContaining('sandbox.safaricom.co.ke/oauth/v1/generate'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }) }),
      );
      expect(mockRedis.setex).toHaveBeenCalledWith('mpesa:access_token', 3500, 'tok-1');
    });

    it('returns the cached token without calling Daraja', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue('cached-tok');

      const token = await service.getAccessToken();

      expect(token).toBe('cached-tok');
      expect(mockHttp.get).not.toHaveBeenCalled();
    });

    it('hits the production host when MPESA_ENVIRONMENT=production', async () => {
      const service = await buildService(makeConfig({ MPESA_ENVIRONMENT: 'production' }));
      mockRedis.get.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(of(axiosResponse({ access_token: 'tok', expires_in: '3599' })));

      await service.getAccessToken();

      expect(mockHttp.get).toHaveBeenCalledWith(
        expect.stringContaining('https://api.safaricom.co.ke/oauth/v1/generate'),
        expect.anything(),
      );
    });

    it('throws InternalServerErrorException when Daraja auth fails', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue(null);
      mockHttp.get.mockReturnValue(throwError(() => new Error('network error')));

      await expect(service.getAccessToken()).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── STK Push ─────────────────────────────────────────────────────────────────

  describe('stkPush', () => {
    it('builds the payload per Daraja spec and rounds amount up', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue('tok');
      mockHttp.post.mockReturnValue(
        of(
          axiosResponse({
            MerchantRequestID: 'm-1',
            CheckoutRequestID: 'c-1',
            ResponseCode: '0',
            ResponseDescription: 'ok',
            CustomerMessage: 'ok',
          }),
        ),
      );

      await service.stkPush('254712345678', 99.4, 'a-very-long-payment-id', 'https://example.com/cb');

      const [url, payload] = mockHttp.post.mock.calls[0];
      expect(url).toContain('/mpesa/stkpush/v1/processrequest');
      expect(payload).toMatchObject({
        BusinessShortCode: '174379',
        TransactionType: 'CustomerPayBillOnline',
        Amount: 100, // Math.ceil(99.4)
        PartyA: '254712345678',
        PhoneNumber: '254712345678',
        CallBackURL: 'https://example.com/cb',
      });
      // AccountReference is capped at 12 chars regardless of input length.
      expect(payload.AccountReference.length).toBeLessThanOrEqual(12);
    });

    it('throws InternalServerErrorException on Daraja failure', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue('tok');
      mockHttp.post.mockReturnValue(throwError(() => new Error('daraja down')));

      await expect(
        service.stkPush('254712345678', 100, 'ref', 'https://cb'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── B2C SecurityCredential ─────────────────────────────────────────────────

  describe('b2cTransfer — SecurityCredential', () => {
    it('encrypts the initiator password with the configured certificate and Daraja can decrypt it back', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue('tok');
      mockHttp.post.mockReturnValue(
        of(
          axiosResponse({
            ConversationID: 'conv-1',
            OriginatorConversationID: 'orig-1',
            ResponseCode: '0',
            ResponseDescription: 'ok',
          }),
        ),
      );

      await service.b2cTransfer('254712345678', 500, 'https://cb/result', 'https://cb/timeout', 'test payout');

      const [, payload] = mockHttp.post.mock.calls[0];
      const credential = payload.SecurityCredential as string;

      // This is the actual contract Daraja depends on: decrypting the
      // credential with the matching private key must recover the exact
      // initiator password we configured.
      const decrypted = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(credential, 'base64'),
      );
      expect(decrypted.toString()).toBe('InitiatorPass123');
    });

    it('uses MPESA_B2C_SECURITY_CREDENTIAL directly when already precomputed, skipping encryption', async () => {
      const service = await buildService(
        makeConfig({ MPESA_B2C_SECURITY_CREDENTIAL: 'already-encrypted-value==' }),
      );
      mockRedis.get.mockResolvedValue('tok');
      mockHttp.post.mockReturnValue(
        of(axiosResponse({ ConversationID: 'c', OriginatorConversationID: 'o', ResponseCode: '0', ResponseDescription: 'ok' })),
      );

      await service.b2cTransfer('254712345678', 500, 'https://cb/result', 'https://cb/timeout', 'payout');

      const [, payload] = mockHttp.post.mock.calls[0];
      expect(payload.SecurityCredential).toBe('already-encrypted-value==');
    });

    it('throws a clear InternalServerErrorException when the certificate is malformed', async () => {
      const service = await buildService(makeConfig({ MPESA_B2C_CERTIFICATE: 'not-a-real-cert' }));
      mockRedis.get.mockResolvedValue('tok');

      await expect(
        service.b2cTransfer('254712345678', 500, 'https://cb/result', 'https://cb/timeout', 'payout'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('floors the amount and builds the B2C payload per Daraja spec', async () => {
      const service = await buildService(makeConfig());
      mockRedis.get.mockResolvedValue('tok');
      mockHttp.post.mockReturnValue(
        of(axiosResponse({ ConversationID: 'c', OriginatorConversationID: 'o', ResponseCode: '0', ResponseDescription: 'ok' })),
      );

      await service.b2cTransfer('254712345678', 499.9, 'https://cb/result', 'https://cb/timeout', 'x'.repeat(200));

      const [url, payload] = mockHttp.post.mock.calls[0];
      expect(url).toContain('/mpesa/b2c/v3/paymentrequest');
      expect(payload).toMatchObject({
        InitiatorName: 'testapi',
        CommandID: 'BusinessPayment',
        Amount: 499, // Math.floor(499.9) — never over-pay
        PartyB: '254712345678',
        QueueTimeOutURL: 'https://cb/timeout',
        ResultURL: 'https://cb/result',
      });
      // Remarks capped at 100 chars per Daraja's field limit.
      expect(payload.Remarks.length).toBeLessThanOrEqual(100);
    });
  });

  // ── Phone normalisation ────────────────────────────────────────────────────

  describe('normalizePhone', () => {
    it.each([
      ['0712345678', '254712345678'],
      ['+254712345678', '254712345678'],
      ['254712345678', '254712345678'],
      ['712345678', '254712345678'],
    ])('%s -> %s', async (input, expected) => {
      const service = await buildService(makeConfig());
      expect(service.normalizePhone(input)).toBe(expected);
    });
  });
});
