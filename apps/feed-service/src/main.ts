import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle('PredictMarket Feed')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app as any, config));

  const port = process.env.FEED_SERVICE_PORT ?? 3008;
  await app.listen(port);
  Logger.log(`feed-service on http://localhost:${port}/api`);
}

bootstrap();
