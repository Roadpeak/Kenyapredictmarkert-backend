import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { KafkaService } from '@org/kafka-client';
import { AnalyticsController } from '../analytics/analytics.controller';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../analytics/prisma.service';
import { JwtAuthGuard } from '@org/decorators';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
  ],
  controllers: [AnalyticsController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    PrismaService,
    AnalyticsService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'analytics-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
