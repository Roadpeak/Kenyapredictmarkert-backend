import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private readonly isDev: boolean;
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {
    this.isDev = config.get('NODE_ENV', 'development') !== 'production';
  }

  onModuleInit() {
    if (this.isDev) return;

    const serviceAccountJson = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!serviceAccountJson) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
      return;
    }

    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
      this.app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      this.logger.log('Firebase Admin SDK initialized');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to init Firebase: ${msg}`);
    }
  }

  async send(token: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
    if (this.isDev) {
      this.logger.log(`[PUSH DEV] Token: ${token.slice(0, 20)}… | ${title}: ${body}`);
      return;
    }

    if (!this.app) return;

    try {
      await admin.messaging(this.app).send({
        token,
        notification: { title, body },
        data,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Push send failed: ${msg}`);
    }
  }

  async sendMulticast(tokens: string[], title: string, body: string, data?: Record<string, string>): Promise<void> {
    if (!tokens.length) return;

    if (this.isDev) {
      this.logger.log(`[PUSH DEV] Multicast (${tokens.length}) | ${title}: ${body}`);
      return;
    }

    if (!this.app) return;

    try {
      const response = await admin.messaging(this.app).sendEachForMulticast({
        tokens,
        notification: { title, body },
        data,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      if (response.failureCount > 0) {
        this.logger.warn(`Push multicast: ${response.failureCount}/${tokens.length} failed`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Push multicast failed: ${msg}`);
    }
  }
}
