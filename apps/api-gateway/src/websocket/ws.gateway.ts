import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { JwtPayload, WsMarketPriceUpdate, WsPaymentUpdate } from '@org/types';

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/ws',
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WsGateway.name);
  private readonly jwtService: JwtService;

  constructor(config: ConfigService) {
    const publicKey = (config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(/\\n/g, '\n');
    this.jwtService = new JwtService({
      publicKey,
      verifyOptions: { algorithms: ['RS256'] },
    });
  }

  handleConnection(client: Socket) {
    const token = (client.handshake.auth as Record<string, unknown>)['token'] as string | undefined
      ?? (client.handshake.headers['authorization'] as string | undefined)?.replace('Bearer ', '');

    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const user = this.jwtService.verify<JwtPayload>(token);
      client.data['user'] = user;
      void client.join(`user:${user.sub}`);
      this.logger.debug(`WS connected: userId=${user.sub} socketId=${client.id}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data['user'] as JwtPayload | undefined)?.sub;
    this.logger.debug(`WS disconnected: userId=${userId ?? 'unknown'} socketId=${client.id}`);
  }

  @SubscribeMessage('subscribe:market')
  handleSubscribeMarket(
    @MessageBody() data: { marketId: string },
    @ConnectedSocket() client: Socket,
  ) {
    void client.join(`market:${data.marketId}`);
    this.logger.debug(`Client ${client.id} subscribed to market:${data.marketId}`);
    return { event: 'subscribed', data: { marketId: data.marketId } };
  }

  @SubscribeMessage('unsubscribe:market')
  handleUnsubscribeMarket(
    @MessageBody() data: { marketId: string },
    @ConnectedSocket() client: Socket,
  ) {
    void client.leave(`market:${data.marketId}`);
    return { event: 'unsubscribed', data: { marketId: data.marketId } };
  }

  // ─── Emit helpers (called by WsConsumer) ────────────────────────────────────

  emitMarketPrice(update: WsMarketPriceUpdate) {
    this.server.to(`market:${update.marketId}`).emit('market:price', update);
  }

  /** Tells client to re-fetch wallet balance from wallet-service */
  emitWalletRefetch(userId: string) {
    this.server.to(`user:${userId}`).emit('wallet:refetch', { userId, timestamp: Date.now() });
  }

  emitPaymentUpdate(userId: string, update: WsPaymentUpdate) {
    this.server.to(`user:${userId}`).emit('payment:update', update);
  }
}
