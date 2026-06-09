import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtStrategy } from '../common/strategies/jwt.strategy';
import { JwtMiddleware } from '../common/middleware/jwt.middleware';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ProxyController } from '../proxy/proxy.controller';
import { ProxyService } from '../proxy/proxy.service';
import { WsGateway } from '../websocket/ws.gateway';
import { WsConsumer } from '../websocket/ws.consumer';
import { KafkaService } from '@org/kafka-client';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    PassportModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: () => ({
        throttlers: [{ ttl: 60000, limit: 120 }], // 120 req/min default
      }),
    }),
  ],
  controllers: [ProxyController],
  providers: [
    JwtStrategy,
    ProxyService,
    WsGateway,
    WsConsumer,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'api-gateway',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(JwtMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
