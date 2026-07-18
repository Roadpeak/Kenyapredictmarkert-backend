import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly bongaUrl: string | undefined;
  private readonly bongaClientId: string | undefined;
  private readonly bongaServiceId: string | undefined;
  private readonly bongaApiKey: string | undefined;
  private readonly bongaApiSecret: string | undefined;
  private readonly isProd: boolean;

  constructor(private readonly config: ConfigService) {
    this.isProd = config.get('NODE_ENV', 'development') === 'production';
    this.bongaUrl = config.get<string>('BONGA_URL');
    this.bongaClientId = config.get<string>('BONGA_CLIENT_ID');
    this.bongaServiceId = config.get<string>('BONGA_SERVICE_ID');
    this.bongaApiKey = config.get<string>('BONGA_API_KEY');
    this.bongaApiSecret = config.get<string>('BONGA_API_SECRET');
  }

  async send(phone: string, message: string): Promise<void> {
    if (!this.isProd) {
      this.logger.log(`[SMS DEV] To: ${phone} | ${message}`);
      return;
    }

    if (!this.bongaUrl || !this.bongaClientId || !this.bongaServiceId || !this.bongaApiKey || !this.bongaApiSecret) {
      this.logger.warn(`Bonga env not fully set — SMS to ${phone} not dispatched`);
      return;
    }

    // Bonga expects bare 254… (no + or leading 0). Our DB already stores
    // in this form, so pass through — but strip any stray + a caller adds.
    // Field names: MSISDN + txtMessage (NOT mobile/message — the gateway
    // returns HTTP 500 with an empty body if the shape is wrong).
    const msisdn = phone.replace(/^\+/, '');
    const body = {
      apiClientID: this.bongaClientId,
      key: this.bongaApiKey,
      secret: this.bongaApiSecret,
      serviceID: this.bongaServiceId,
      MSISDN: msisdn,
      txtMessage: message,
    };

    try {
      const res = await fetch(this.bongaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await res.text().catch(() => '');
      let data: { status?: number; status_message?: string; error?: unknown } = {};
      try { data = JSON.parse(raw); } catch { /* non-JSON body */ }

      // Bonga returns 200 OK with a JSON body:  {status:222,status_message:"sent"} on success,
      // {status:666, …} on delivery failure. Treat everything else as unknown.
      if (data.status === 666) {
        this.logger.error(`Bonga rejected SMS to ${msisdn}: ${raw.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        this.logger.error(`Bonga SMS to ${msisdn} failed: HTTP ${res.status} ${raw.slice(0, 200)}`);
        return;
      }
      this.logger.log(`SMS sent to ${msisdn} (status=${data.status ?? res.status})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Bonga SMS to ${msisdn} threw: ${msg}`);
      // Don't rethrow — notification failures are non-fatal to auth flow
    }
  }
}
