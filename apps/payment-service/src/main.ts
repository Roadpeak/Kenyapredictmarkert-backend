import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();
  const port = process.env.PAYMENT_SERVICE_PORT ?? 3006;
  await app.listen(port);
  Logger.log(`payment-service running on http://localhost:${port}/api`);
}

bootstrap();
