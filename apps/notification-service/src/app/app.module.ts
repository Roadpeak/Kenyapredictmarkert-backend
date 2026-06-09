import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationController } from '../notification/notification.controller';
import { NotificationService } from '../notification/notification.service';
import { NotificationConsumer } from '../notification/notification.consumer';
import { PrismaService } from '../notification/prisma.service';
import { SmsService } from '../notification/sms.service';
import { PushService } from '../notification/push.service';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [NotificationController],
  providers: [
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
