import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: '*', credentials: true });

  // In production this sits behind nginx (see nginx/nginx.conf), which is
  // the gateway's one hop. Without trust proxy, req.ip resolves to nginx's
  // address rather than the real client — and this gateway re-stamps
  // x-forwarded-for with req.ip (see proxy.service.ts) before forwarding to
  // downstream services, so getting this wrong here breaks their IP checks
  // too (payment-service's M-Pesa callback allowlist depends on it).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('KenyaPolymarket API')
    .setDescription('Kenyan prediction market platform')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, doc);

  const port = process.env.GATEWAY_PORT ?? 3000;
  await app.listen(port);
  Logger.log(`API Gateway running on http://localhost:${port}`);
  Logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
