import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsGateway } from './ws.gateway';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSocket(token?: string, headerToken?: string): any {
  const rooms = new Set<string>();
  return {
    id: 'socket-1',
    data: {},
    handshake: {
      auth: token ? { token } : {},
      headers: headerToken ? { authorization: `Bearer ${headerToken}` } : {},
    },
    join: jest.fn((room: string) => { rooms.add(room); return Promise.resolve(); }),
    leave: jest.fn((room: string) => { rooms.delete(room); return Promise.resolve(); }),
    disconnect: jest.fn(),
    _rooms: rooms,
  };
}

function makeServer(): any {
  const toResult = { emit: jest.fn() };
  return {
    to: jest.fn(() => toResult),
    _emitResult: toResult,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WsGateway', () => {
  let gateway: WsGateway;
  let jwtVerify: jest.SpyInstance;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => (key === 'JWT_PUBLIC_KEY' ? 'test-public-key' : undefined)),
    } as unknown as ConfigService;

    gateway = new WsGateway(config);

    jwtVerify = jest.spyOn(JwtService.prototype, 'verify');
  });

  afterEach(() => {
    jwtVerify.mockRestore();
  });

  // ── handleConnection ────────────────────────────────────────────────────────

  describe('handleConnection', () => {
    it('disconnects when no token provided', () => {
      const socket = makeSocket(); // no token in auth or header
      gateway.handleConnection(socket);
      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('disconnects when JWT verification fails', () => {
      jwtVerify.mockImplementation(() => { throw new Error('invalid signature'); });
      const socket = makeSocket('bad-token');
      gateway.handleConnection(socket);
      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('joins user room on successful connect via handshake.auth.token', () => {
      const payload = { sub: 'user-1', role: 'USER', kycTier: 1 };
      jwtVerify.mockReturnValue(payload);

      const socket = makeSocket('valid-token');
      gateway.handleConnection(socket);

      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.join).toHaveBeenCalledWith('user:user-1');
      expect(socket.data['user']).toEqual(payload);
    });

    it('joins user room via Authorization header token', () => {
      const payload = { sub: 'user-2', role: 'USER', kycTier: 0 };
      jwtVerify.mockReturnValue(payload);

      // No auth.token, but header present
      const socket = makeSocket(undefined, 'header-valid-token');
      gateway.handleConnection(socket);

      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.join).toHaveBeenCalledWith('user:user-2');
    });

    it('prefers handshake.auth.token over header', () => {
      const payload = { sub: 'user-auth', role: 'USER', kycTier: 1 };
      jwtVerify.mockReturnValue(payload);

      const socket = makeSocket('auth-token', 'header-token');
      gateway.handleConnection(socket);

      // Verify was called with the auth.token value
      expect(jwtVerify).toHaveBeenCalledWith('auth-token');
    });
  });

  // ── handleDisconnect ────────────────────────────────────────────────────────

  describe('handleDisconnect', () => {
    it('does not throw when user is undefined (anonymous socket)', () => {
      const socket = makeSocket();
      socket.data = {};
      expect(() => gateway.handleDisconnect(socket)).not.toThrow();
    });

    it('does not throw for authenticated socket', () => {
      const payload = { sub: 'user-1', role: 'USER', kycTier: 1 };
      jwtVerify.mockReturnValue(payload);
      const socket = makeSocket('valid-token');
      gateway.handleConnection(socket);
      expect(() => gateway.handleDisconnect(socket)).not.toThrow();
    });
  });

  // ── subscribe:market ────────────────────────────────────────────────────────

  describe('handleSubscribeMarket', () => {
    it('joins the market room and returns subscribed event', () => {
      const socket = makeSocket();
      const result = gateway.handleSubscribeMarket({ marketId: 'market-1' }, socket);

      expect(socket.join).toHaveBeenCalledWith('market:market-1');
      expect(result).toEqual({ event: 'subscribed', data: { marketId: 'market-1' } });
    });
  });

  // ── unsubscribe:market ──────────────────────────────────────────────────────

  describe('handleUnsubscribeMarket', () => {
    it('leaves the market room and returns unsubscribed event', () => {
      const socket = makeSocket();
      const result = gateway.handleUnsubscribeMarket({ marketId: 'market-1' }, socket);

      expect(socket.leave).toHaveBeenCalledWith('market:market-1');
      expect(result).toEqual({ event: 'unsubscribed', data: { marketId: 'market-1' } });
    });
  });

  // ── emit helpers ────────────────────────────────────────────────────────────

  describe('emit helpers', () => {
    beforeEach(() => {
      gateway.server = makeServer();
    });

    it('emitMarketPrice emits to market room', () => {
      const update = { marketId: 'market-1', yesPrice: 0.65, noPrice: 0.35, timestamp: Date.now() };
      gateway.emitMarketPrice(update as any);

      expect(gateway.server.to).toHaveBeenCalledWith('market:market-1');
      expect((gateway.server as any)._emitResult.emit).toHaveBeenCalledWith('market:price', update);
    });

    it('emitWalletRefetch emits to user room with userId', () => {
      gateway.emitWalletRefetch('user-1');

      expect(gateway.server.to).toHaveBeenCalledWith('user:user-1');
      expect((gateway.server as any)._emitResult.emit).toHaveBeenCalledWith(
        'wallet:refetch',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('emitPaymentUpdate emits to user room', () => {
      const update = { paymentId: 'pay-1', status: 'COMPLETED' };
      gateway.emitPaymentUpdate('user-1', update as any);

      expect(gateway.server.to).toHaveBeenCalledWith('user:user-1');
      expect((gateway.server as any)._emitResult.emit).toHaveBeenCalledWith('payment:update', update);
    });
  });
});
