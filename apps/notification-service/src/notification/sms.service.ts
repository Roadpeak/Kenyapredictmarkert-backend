import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// Africa's Talking doesn't ship ESM types — import with require for CJS compat
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AfricasTalking = require('africastalking');

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly at: ReturnType<typeof AfricasTalking>;
  private readonly isDev: boolean;

  constructor(private readonly config: ConfigService) {
    this.isDev = config.get('NODE_ENV', 'development') !== 'production';

    if (!this.isDev) {
      this.at = AfricasTalking({
        apiKey: config.getOrThrow<string>('AT_API_KEY'),
        username: config.getOrThrow<string>('AT_USERNAME'),
      });
    }
  }

  async send(phone: string, message: string): Promise<void> {
    if (this.isDev) {
      this.logger.log(`[SMS DEV] To: ${phone} | ${message}`);
      return;
    }

    // Africa's Talking requires E.164 (+254…); our DB stores bare 254…
    // so it can validate the "country calling code" from the leading +.
    const e164 = phone.startsWith('+') ? phone : `+${phone}`;
    try {
      await this.at.SMS.send({
        to: [e164],
        message,
        from: this.config.get('AT_SENDER_ID', 'PredictMkt'),
      });
      this.logger.log(`SMS sent to ${e164}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`SMS send failed to ${phone}: ${msg}`);
      // Don't throw — notification failures are non-fatal
    }
  }
}
