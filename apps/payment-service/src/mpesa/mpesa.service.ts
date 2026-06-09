import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { firstValueFrom } from 'rxjs';
import { format } from 'date-fns';
import {
  DarajaTokenResponse,
  StkPushRequest,
  StkPushResponse,
  StkQueryResponse,
  B2cRequest,
  B2cResponse,
} from './mpesa.types';

const MPESA_TOKEN_CACHE_KEY = 'mpesa:access_token';
const MPESA_TOKEN_TTL_SECONDS = 3500; // Daraja tokens expire in 3600s

@Injectable()
export class MpesaService {
  private readonly logger = new Logger(MpesaService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── Access Token (cached) ────────────────────────────────────────────────────

  async getAccessToken(): Promise<string> {
    const cached = await this.redis.get(MPESA_TOKEN_CACHE_KEY);
    if (cached) return cached;

    const consumerKey = this.config.getOrThrow<string>('MPESA_CONSUMER_KEY');
    const consumerSecret = this.config.getOrThrow<string>('MPESA_CONSUMER_SECRET');
    const env = this.config.get('MPESA_ENVIRONMENT', 'sandbox');

    const baseUrl = env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    try {
      const response = await firstValueFrom(
        this.http.get<DarajaTokenResponse>(
          `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
          { headers: { Authorization: `Basic ${credentials}` } },
        ),
      );

      const token = response.data.access_token;
      await this.redis.setex(MPESA_TOKEN_CACHE_KEY, MPESA_TOKEN_TTL_SECONDS, token);
      this.logger.log('M-Pesa access token refreshed');
      return token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to get M-Pesa token: ${msg}`);
      throw new InternalServerErrorException('Failed to authenticate with M-Pesa');
    }
  }

  // ─── STK Push (deposit) ───────────────────────────────────────────────────────

  async stkPush(
    phone: string,       // 254XXXXXXXXX
    amountKes: number,
    accountRef: string,  // e.g. userId or depositId (max 12 chars)
    callbackUrl: string,
  ): Promise<StkPushResponse> {
    const token = await this.getAccessToken();
    const shortCode = this.config.getOrThrow<string>('MPESA_SHORT_CODE');
    const passkey = this.config.getOrThrow<string>('MPESA_PASSKEY');
    const env = this.config.get('MPESA_ENVIRONMENT', 'sandbox');

    const baseUrl = env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    const timestamp = format(new Date(), 'yyyyMMddHHmmss');
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');

    const payload: StkPushRequest = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amountKes), // M-Pesa requires integer amounts
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef.slice(0, 12),
      TransactionDesc: 'PM Deposit'.slice(0, 13),
    };

    try {
      const response = await firstValueFrom(
        this.http.post<StkPushResponse>(
          `${baseUrl}/mpesa/stkpush/v1/processrequest`,
          payload,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      this.logger.log(
        `STK Push sent: phone=${phone} amount=${amountKes} checkoutId=${response.data.CheckoutRequestID}`,
      );
      return response.data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`STK Push failed: ${msg}`);
      throw new InternalServerErrorException('Failed to initiate M-Pesa payment');
    }
  }

  // ─── Query STK Push status (verify before crediting) ─────────────────────────

  async queryStkPush(checkoutRequestId: string): Promise<StkQueryResponse> {
    const token = await this.getAccessToken();
    const shortCode = this.config.getOrThrow<string>('MPESA_SHORT_CODE');
    const passkey = this.config.getOrThrow<string>('MPESA_PASSKEY');
    const env = this.config.get('MPESA_ENVIRONMENT', 'sandbox');

    const baseUrl = env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    const timestamp = format(new Date(), 'yyyyMMddHHmmss');
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');

    const response = await firstValueFrom(
      this.http.post<StkQueryResponse>(
        `${baseUrl}/mpesa/stkpushquery/v1/query`,
        {
          BusinessShortCode: shortCode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );

    return response.data;
  }

  // ─── B2C (withdrawal) ─────────────────────────────────────────────────────────

  async b2cTransfer(
    phone: string,      // 254XXXXXXXXX
    amountKes: number,
    resultUrl: string,
    timeoutUrl: string,
    remarks: string,
  ): Promise<B2cResponse> {
    const token = await this.getAccessToken();
    const shortCode = this.config.getOrThrow<string>('MPESA_SHORT_CODE');
    const initiatorName = this.config.getOrThrow<string>('MPESA_B2C_INITIATOR_NAME');
    const securityCredential = this.config.getOrThrow<string>('MPESA_B2C_SECURITY_CREDENTIAL');
    const env = this.config.get('MPESA_ENVIRONMENT', 'sandbox');

    const baseUrl = env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    const payload: B2cRequest = {
      InitiatorName: initiatorName,
      SecurityCredential: securityCredential,
      CommandID: 'BusinessPayment',
      Amount: Math.floor(amountKes), // Floor for withdrawals — don't over-pay
      PartyA: shortCode,
      PartyB: phone,
      Remarks: remarks.slice(0, 100),
      QueueTimeOutURL: timeoutUrl,
      ResultURL: resultUrl,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<B2cResponse>(
          `${baseUrl}/mpesa/b2c/v3/paymentrequest`,
          payload,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      this.logger.log(
        `B2C initiated: phone=${phone} amount=${amountKes} convId=${response.data.ConversationID}`,
      );
      return response.data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`B2C transfer failed: ${msg}`);
      throw new InternalServerErrorException('Failed to initiate M-Pesa withdrawal');
    }
  }

  // ─── Phone normalisation ──────────────────────────────────────────────────────

  normalizePhone(phone: string): string {
    const cleaned = phone.replace(/\s+/g, '').replace(/^\+/, '').replace(/^0/, '254');
    return cleaned.startsWith('254') ? cleaned : `254${cleaned}`;
  }
}
