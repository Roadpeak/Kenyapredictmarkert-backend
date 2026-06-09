import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WalletController } from '../wallet/wallet.controller';
import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../wallet/prisma.service';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [WalletController],
  providers: [
    WalletService,
    PrismaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'wallet-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly walletService: WalletService) {}

  async onModuleInit() {
    await this.walletService.startKafkaConsumers();
  }
}
