import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();

  // Requests reach this service via api-gateway, not directly — @Ip() in
  // PaymentController's M-Pesa callback IP check reads req.ip, which Express
  // only derives from X-Forwarded-For when trust proxy is set. Without this,
  // req.ip is the gateway's address, never a Safaricom IP, and every real
  // callback in production gets rejected as "unauthorized".
  // Trusting a single hop (the gateway) rather than 'true' (any hop) avoids
  // spoofing via a client-supplied X-Forwarded-For reaching the gateway.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  const port = process.env.PAYMENT_SERVICE_PORT ?? 3006;
  await app.listen(port);
  Logger.log(`payment-service running on http://localhost:${port}/api`);
}

bootstrap();
