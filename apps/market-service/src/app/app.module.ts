import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MarketController } from '../market/market.controller';
import { MarketService } from '../market/market.service';
import { PrismaService } from '../market/prisma.service';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [MarketController],
  providers: [
    MarketService,
    PrismaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'market-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
