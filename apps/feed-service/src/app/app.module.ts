import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { FeedController } from '../feed/feed.controller';
import { FeedService } from '../feed/feed.service';
import { PrismaService } from '../feed/prisma.service';
import { KafkaService } from '@org/kafka-client';
import { JwtAuthGuard } from '@org/decorators';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HttpModule],
  controllers: [FeedController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    FeedService,
    PrismaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'feed-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
