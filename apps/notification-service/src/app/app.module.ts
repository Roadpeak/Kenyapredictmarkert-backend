import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationController } from '../notification/notification.controller';
import { NotificationService } from '../notification/notification.service';
import { NotificationConsumer } from '../notification/notification.consumer';
import { PrismaService } from '../notification/prisma.service';
import { SmsService } from '../notification/sms.service';
import { PushService } from '../notification/push.service';
import { KafkaService } from '@org/kafka-client';
import { JwtAuthGuard } from '@org/decorators';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [NotificationController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    NotificationService,
    NotificationConsumer,
    PrismaService,
    SmsService,
    PushService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'notification-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
