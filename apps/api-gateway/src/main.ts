import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: '*', credentials: true });

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('PredictMarket API')
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
