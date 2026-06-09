import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { PrismaService } from './prisma.service';
import { PushService } from './push.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  notification: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  deviceToken: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const mockPush = {
  sendMulticast: jest.fn().mockResolvedValue(undefined),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeNotification = (overrides = {}) => ({
  id: 'notif-1',
  userId: 'user-1',
  type: 'TRADE_CONFIRMED',
  channel: 'IN_APP',
  title: 'Trade Confirmed',
  body: 'You bought 10 YES shares',
  status: 'SENT',
  createdAt: new Date(),
  readAt: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PushService, useValue: mockPush },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  // ── onTradeConfirmed ────────────────────────────────────────────────────────

  describe('onTradeConfirmed', () => {
    const payload = {
      userId: 'user-1',
      tradeId: 'trade-1',
      marketId: 'market-1',
      marketTitle: 'Will it rain?',
      outcome: 'YES',
      sharesCount: 5,
      amountKes: 500,
      pricePerShare: 0.6,
    };

    beforeEach(() => {
      mockPrisma.notification.create.mockResolvedValue({});
      mockPrisma.deviceToken.findMany.mockResolvedValue([]);
    });

    it('creates an in-app notification', async () => {
      await service.onTradeConfirmed(payload as any);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            title: 'Trade Confirmed',
            type: 'TRADE_CONFIRMED',
          }),
        }),
      );
    });

    it('body includes shares count and market title', async () => {
      await service.onTradeConfirmed(payload as any);
      const call = mockPrisma.notification.create.mock.calls[0][0];
      expect(call.data.body).toContain('5');
      expect(call.data.body).toContain('YES');
      expect(call.data.body).toContain('Will it rain?');
    });

    it('dispatches push notification when device tokens exist', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'fcm-token-1' }]);
      await service.onTradeConfirmed(payload as any);
      expect(mockPush.sendMulticast).toHaveBeenCalledWith(
        ['fcm-token-1'],
        'Trade Confirmed',
        expect.any(String),
      );
    });

    it('skips push when no device tokens', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([]);
      await service.onTradeConfirmed(payload as any);
      expect(mockPush.sendMulticast).not.toHaveBeenCalled();
    });
  });

  // ── onMarketSettled ─────────────────────────────────────────────────────────

  describe('onMarketSettled', () => {
    beforeEach(() => {
      mockPrisma.notification.create.mockResolvedValue({});
      mockPrisma.deviceToken.findMany.mockResolvedValue([]);
    });

    it('sends "You Won!" title when outcome matches winningOutcome', async () => {
      await service.onMarketSettled({
        userId: 'user-1', marketId: 'm-1', marketTitle: 'Test', outcome: 'YES', winningOutcome: 'YES', payoutKes: 1500, sharesHeld: 100,
      } as any);
      const call = mockPrisma.notification.create.mock.calls[0][0];
      expect(call.data.title).toBe('You Won!');
      expect(call.data.body).toContain('1,500');
    });

    it('sends "Market Resolved" title when user did not win', async () => {
      await service.onMarketSettled({
        userId: 'user-1', marketId: 'm-1', marketTitle: 'Test', outcome: 'NO', winningOutcome: 'YES', payoutKes: 0, sharesHeld: 50,
      } as any);
      const call = mockPrisma.notification.create.mock.calls[0][0];
      expect(call.data.title).toBe('Market Resolved');
      expect(call.data.body).toContain('YES');
    });
  });

  // ── onDepositCompleted ──────────────────────────────────────────────────────

  describe('onDepositCompleted', () => {
    it('creates deposit notification with receipt number in body', async () => {
      mockPrisma.notification.create.mockResolvedValue({});
      mockPrisma.deviceToken.findMany.mockResolvedValue([]);

      await service.onDepositCompleted({ userId: 'user-1', paymentId: 'pay-1', amountKes: 2000, mpesaReceiptNumber: 'NLJ7RT61SV' } as any);

      const call = mockPrisma.notification.create.mock.calls[0][0];
      expect(call.data.title).toBe('Deposit Received');
      expect(call.data.body).toContain('NLJ7RT61SV');
    });
  });

  // ── onWithdrawalCompleted ───────────────────────────────────────────────────

  describe('onWithdrawalCompleted', () => {
    it('creates withdrawal completed notification with phone', async () => {
      mockPrisma.notification.create.mockResolvedValue({});
      mockPrisma.deviceToken.findMany.mockResolvedValue([]);

      await service.onWithdrawalCompleted({ userId: 'user-1', paymentId: 'pay-1', amountKes: 3000, phone: '254712345678' } as any);

      const call = mockPrisma.notification.create.mock.calls[0][0];
      expect(call.data.title).toBe('Withdrawal Sent');
      expect(call.data.body).toContain('254712345678');
    });
  });

  // ── onWithdrawalFailed ──────────────────────────────────────────────────────

  describe('onWithdrawalFailed', () => {
    it('creates failure notification with reason', async () => {
      mockPrisma.notification.create.mockResolvedValue({});
      mockPrisma.deviceToken.findMany.mockResolvedValue([]);

      await service.onWithdrawalFailed({ userId: 'user-1', amountKes: 1000, reason: 'Network error' } as any);

      const call = mockPrisma.notification.create.mock.calls[0][0];
      expect(call.data.title).toBe('Withdrawal Failed');
      expect(call.data.body).toContain('Network error');
    });
  });

  // ── getForUser ──────────────────────────────────────────────────────────────

  describe('getForUser', () => {
    it('returns paginated notifications with unreadCount', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([makeNotification()]);
      mockPrisma.notification.count
        .mockResolvedValueOnce(5)   // total
        .mockResolvedValueOnce(3);  // unread

      const result = await service.getForUser('user-1', 1, 20);
      expect(result).toMatchObject({
        notifications: expect.any(Array),
        total: 5,
        unreadCount: 3,
        page: 1,
        limit: 20,
      });
    });

    it('queries only IN_APP channel', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);

      await service.getForUser('user-1', 1, 10);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ channel: 'IN_APP' }) }),
      );
    });
  });

  // ── markRead ────────────────────────────────────────────────────────────────

  describe('markRead', () => {
    it('updates notification status to READ with readAt timestamp', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

      await service.markRead('user-1', 'notif-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'notif-1', userId: 'user-1' },
          data: expect.objectContaining({ status: 'READ' }),
        }),
      );
    });
  });

  // ── markAllRead ─────────────────────────────────────────────────────────────

  describe('markAllRead', () => {
    it('marks all SENT in-app notifications as READ', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 4 });

      await service.markAllRead('user-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', channel: 'IN_APP', status: 'SENT' },
        }),
      );
    });
  });

  // ── registerDeviceToken ─────────────────────────────────────────────────────

  describe('registerDeviceToken', () => {
    it('upserts device token by token value', async () => {
      mockPrisma.deviceToken.upsert.mockResolvedValue({});

      await service.registerDeviceToken('user-1', 'fcm-abc123', 'android');

      expect(mockPrisma.deviceToken.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token: 'fcm-abc123' },
          create: { userId: 'user-1', token: 'fcm-abc123', platform: 'android' },
          update: { userId: 'user-1', platform: 'android' },
        }),
      );
    });
  });
});
