import { Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MarketController } from '../market/market.controller';
import { MarketService } from '../market/market.service';
import { PrismaService } from '../market/prisma.service';
import { KafkaService } from '@org/kafka-client';
import { JwtAuthGuard } from '@org/decorators';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot()],
  controllers: [MarketController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
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
export class AppModule implements OnModuleInit {
  constructor(private readonly marketService: MarketService) {}

  async onModuleInit() {
    await this.marketService.startKafkaConsumers();
  }
}
