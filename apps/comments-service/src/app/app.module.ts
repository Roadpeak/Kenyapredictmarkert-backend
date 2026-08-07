import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CommentsController } from '../comments/comments.controller';
import { CommentsService } from '../comments/comments.service';
import { PrismaService } from '../comments/prisma.service';
import { KafkaService } from '@org/kafka-client';
import { JwtAuthGuard } from '@org/decorators';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HttpModule],
  controllers: [CommentsController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    CommentsService,
    PrismaService,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'comments-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
