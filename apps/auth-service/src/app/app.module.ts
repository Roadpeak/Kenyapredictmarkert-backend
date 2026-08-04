import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from '../auth/auth.controller';
import { InternalController } from '../auth/internal.controller';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../auth/prisma.service';
import { JwtStrategy } from '../common/strategies/jwt.strategy';
import { KafkaService } from '@org/kafka-client';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        privateKey: (config.get<string>('JWT_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n'),
        publicKey: (config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(/\\n/g, '\n'),
        signOptions: {
          algorithm: 'RS256',
          expiresIn: config.get('JWT_ACCESS_EXPIRES_IN', '15m'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, InternalController],
  providers: [
    AuthService,
    PrismaService,
    JwtStrategy,
    {
      provide: KafkaService,
      useFactory: (config: ConfigService) =>
        new KafkaService(
          config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
          'auth-service',
        ),
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
