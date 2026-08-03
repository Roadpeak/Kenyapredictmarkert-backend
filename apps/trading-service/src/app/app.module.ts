import { Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { TradingController } from '../trading/trading.controller';
import { TradingService } from '../trading/trading.service';
import { PrismaService } from '../trading/prisma.service';
import { KafkaService } from '@org/kafka-client';
import { JwtAuthGuard } from '@org/decorators';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
  ],
  controllers: [TradingController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    TradingService,
    PrismaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'trading-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly tradingService: TradingService) {}

  async onModuleInit() {
    await this.tradingService.startKafkaConsumers();
  }
}
