import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { RedisModule } from '@nestjs-modules/ioredis';
import { PaymentController } from '../payment/payment.controller';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../payment/prisma.service';
import { MpesaService } from '../mpesa/mpesa.service';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: `redis://${config.get('REDIS_HOST', 'localhost')}:${config.get('REDIS_PORT', 6379)}`,
        options: {
          password: config.get('REDIS_PASSWORD') || undefined,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PrismaService,
    MpesaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'payment-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
