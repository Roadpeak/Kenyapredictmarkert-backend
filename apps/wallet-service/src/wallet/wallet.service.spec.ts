import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';
import { LedgerType, Direction } from '@org/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const makeTx = () => ({
  wallet: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn(), create: jest.fn() },
  ledgerEntry: { create: jest.fn(), findFirst: jest.fn() },
});

let tx = makeTx();

const mockPrisma = {
  wallet: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  ledgerEntry: {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn((fn: (tx: any) => any) => fn(tx)),
};

const mockKafka = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };

jest.mock('@org/utils', () => ({
  generateSettlementId: jest.fn(
    (m: string, u: string, o: string) => `settlement-${m}-${u}-${o}`,
  ),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeWallet = (overrides = {}) => ({
  id: 'wallet-1',
  userId: 'user-1',
  balance: 5000,
  reservedBalance: 200,
  lifetimeDeposit: 10000,
  lifetimeWithdraw: 0,
  lifetimePayout: 0,
  currency: 'KES',
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tx = makeTx();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KafkaService, useValue: mockKafka },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  // ── getWallet ───────────────────────────────────────────────────────────────

  describe('getWallet', () => {
    it('returns wallet with computed availableBalance', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet());
      const result = await service.getWallet('user-1');
      expect(result).toMatchObject({
        userId: 'user-1',
        balance: 5000,
        reservedBalance: 200,
        availableBalance: 4800,
      });
    });

    it('throws NotFoundException when wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      await expect(service.getWallet('user-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── getLedger ───────────────────────────────────────────────────────────────

  describe('getLedger', () => {
    it('returns paginated ledger entries', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet());
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      mockPrisma.ledgerEntry.count.mockResolvedValue(0);

      const result = await service.getLedger('user-1', 1, 20);
      expect(result).toMatchObject({ data: [], meta: expect.objectContaining({ total: 0 }) });
    });
  });

  // ── credit ──────────────────────────────────────────────────────────────────

  describe('credit', () => {
    it('increases balance and creates ledger CREDIT entry', async () => {
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ balance: 1000 }));
      tx.wallet.update.mockResolvedValue({});
      tx.ledgerEntry.create.mockResolvedValue({});

      await service.credit('user-1', 500, LedgerType.DEPOSIT, 'pay-1', 'DEPOSIT', 'M-Pesa deposit');

      expect(tx.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ balance: 1500 }) }),
      );
      expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: Direction.CREDIT,
            amount: 500,
            balanceBefore: 1000,
            balanceAfter: 1500,
          }),
        }),
      );
    });

    it('throws NotFoundException when wallet not found in transaction', async () => {
      tx.wallet.findUnique.mockResolvedValue(null);
      await expect(
        service.credit('user-1', 500, LedgerType.DEPOSIT, 'ref', 'DEPOSIT'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── debit ───────────────────────────────────────────────────────────────────

  describe('debit', () => {
    it('decreases balance and creates ledger DEBIT entry', async () => {
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ balance: 5000, reservedBalance: 0 }));
      tx.wallet.update.mockResolvedValue({});
      tx.ledgerEntry.create.mockResolvedValue({});

      await service.debit('user-1', 200, LedgerType.TRADE_DEBIT, 'trade-1', 'TRADE_DEBIT');

      expect(tx.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ balance: 4800 }) }),
      );
    });

    it('throws BadRequestException when available balance is insufficient', async () => {
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ balance: 100, reservedBalance: 0 }));
      await expect(
        service.debit('user-1', 500, LedgerType.TRADE_DEBIT, 'ref', 'TRADE_DEBIT'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when available (balance - reserved) is insufficient', async () => {
      // balance=500, reserved=400, available=100 — cannot debit 200
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ balance: 500, reservedBalance: 400 }));
      await expect(
        service.debit('user-1', 200, LedgerType.TRADE_DEBIT, 'ref', 'TRADE_DEBIT'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── reserve ─────────────────────────────────────────────────────────────────

  describe('reserve', () => {
    it('increases reservedBalance and creates ledger entry', async () => {
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ balance: 5000, reservedBalance: 0 }));
      tx.wallet.update.mockResolvedValue({});
      tx.ledgerEntry.create.mockResolvedValue({});

      await service.reserve('user-1', 200, 'trade-idem-key');

      expect(tx.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reservedBalance: { increment: 200 } }),
        }),
      );
    });

    it('throws BadRequestException when available balance is too low', async () => {
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ balance: 100, reservedBalance: 0 }));
      await expect(service.reserve('user-1', 500, 'ref')).rejects.toThrow(BadRequestException);
    });
  });

  // ── releaseReserve ──────────────────────────────────────────────────────────

  describe('releaseReserve', () => {
    it('decreases reservedBalance', async () => {
      tx.wallet.findUnique.mockResolvedValue(makeWallet({ reservedBalance: 200 }));
      tx.wallet.update.mockResolvedValue({});
      tx.ledgerEntry.create.mockResolvedValue({});

      await service.releaseReserve('user-1', 200, 'trade-ref');

      expect(tx.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reservedBalance: { decrement: 200 } }),
        }),
      );
    });

    it('silently returns when wallet not found (graceful release)', async () => {
      tx.wallet.findUnique.mockResolvedValue(null);
      await expect(service.releaseReserve('user-1', 200, 'ref')).resolves.toBeUndefined();
    });
  });

  // ── settleMarket ────────────────────────────────────────────────────────────

  describe('settleMarket', () => {
    const payload = {
      marketId: 'market-1',
      marketTitle: 'Test Market',
      winningOutcome: 'YES' as any,
      userId: 'user-1',
      outcome: 'YES' as any,
      payoutKes: 1500,
      sharesHeld: 100,
    };

    it('credits payout to wallet and creates ledger entry', async () => {
      mockPrisma.ledgerEntry.findFirst.mockResolvedValue(null); // not already settled
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet()); // ensureWallet
      tx.wallet.findUniqueOrThrow.mockResolvedValue(makeWallet({ balance: 1000 }));
      tx.wallet.update.mockResolvedValue({});
      tx.ledgerEntry.create.mockResolvedValue({});

      await service.settleMarket(payload);

      expect(tx.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ balance: { increment: 1500 }, lifetimePayout: { increment: 1500 } }),
        }),
      );
    });

    it('skips if settlement already processed (idempotency)', async () => {
      mockPrisma.ledgerEntry.findFirst.mockResolvedValue({ id: 'ledger-1' }); // already exists
      await service.settleMarket(payload);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── createWallet ────────────────────────────────────────────────────────────

  describe('createWallet', () => {
    it('creates wallet for new user', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(makeWallet({ balance: 0 }));

      await service.createWallet('user-1');
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', balance: 0 }) }),
      );
    });

    it('is idempotent — skips creation if wallet exists', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet());
      await service.createWallet('user-1');
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });
  });
});
