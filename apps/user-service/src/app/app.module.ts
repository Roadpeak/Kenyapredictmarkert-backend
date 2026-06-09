import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UserController } from '../user/user.controller';
import { UserService } from '../user/user.service';
import { PrismaService } from '../user/prisma.service';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [UserController],
  providers: [
    UserService,
    PrismaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'user-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly userService: UserService) {}

  async onModuleInit() {
    await this.userService.startKafkaConsumers();
  }
}
