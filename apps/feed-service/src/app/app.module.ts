import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { FeedController } from '../feed/feed.controller';
import { FeedService } from '../feed/feed.service';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HttpModule],
  controllers: [FeedController],
  providers: [
    FeedService,
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
