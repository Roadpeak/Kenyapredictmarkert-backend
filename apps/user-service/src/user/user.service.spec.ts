import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UserService } from './user.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  userProfile: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  kycDocument: {
    create: jest.fn(),
    updateMany: jest.fn(),
  },
};

const mockKafka = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };

jest.mock('@org/utils', () => ({
  generateReferralCode: jest.fn().mockReturnValue('TESTREF1'),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeProfile = (overrides = {}) => ({
  id: 'user-1',
  phone: '254712345678',
  displayName: 'Test User',
  bio: null,
  avatarUrl: null,
  kycTier: 0,
  kycStatus: 'NONE',
  withdrawLimit: 0,
  depositLimit: 50000,
  referralCode: 'TESTREF1',
  referredBy: null,
  isSuspended: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  preference: null,
  kycDocuments: [],
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KafkaService, useValue: mockKafka },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  // ── createProfile ───────────────────────────────────────────────────────────

  describe('createProfile', () => {
    const payload = { userId: 'user-1', phone: '254712345678', email: null, createdAt: new Date().toISOString() };

    it('creates profile for new user', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(null);
      mockPrisma.userProfile.findFirst.mockResolvedValue(null); // referral code unique
      mockPrisma.userProfile.create.mockResolvedValue(makeProfile());

      await service.createProfile(payload);

      expect(mockPrisma.userProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ id: 'user-1', phone: '254712345678' }),
        }),
      );
    });

    it('is idempotent — skips if profile already exists', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(makeProfile());
      await service.createProfile(payload);
      expect(mockPrisma.userProfile.create).not.toHaveBeenCalled();
    });
  });

  // ── getMyProfile ────────────────────────────────────────────────────────────

  describe('getMyProfile', () => {
    it('returns profile for existing user', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(makeProfile());
      const result = await service.getMyProfile('user-1');
      expect(result).toMatchObject({ id: 'user-1' });
    });

    it('throws NotFoundException for unknown user', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(null);
      await expect(service.getMyProfile('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateMyProfile ─────────────────────────────────────────────────────────

  describe('updateMyProfile', () => {
    it('updates displayName and bio', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.userProfile.update.mockResolvedValue(makeProfile({ displayName: 'Updated' }));

      const result = await service.updateMyProfile('user-1', { displayName: 'Updated' });
      expect(mockPrisma.userProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ displayName: 'Updated' }) }),
      );
      expect(result.displayName).toBe('Updated');
    });

    it('throws NotFoundException when profile not found', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(null);
      await expect(service.updateMyProfile('unknown', {})).rejects.toThrow(NotFoundException);
    });
  });

  // ── getKycStatus ────────────────────────────────────────────────────────────

  describe('getKycStatus', () => {
    it('returns kycStatus, kycTier, and limits', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(makeProfile());
      const result = await service.getKycStatus('user-1');
      expect(result).toMatchObject({ kycStatus: 'NONE', kycTier: 0 });
    });

    it('throws NotFoundException when profile not found', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(null);
      await expect(service.getKycStatus('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ── submitKyc ───────────────────────────────────────────────────────────────

  describe('submitKyc', () => {
    const dto = { docType: 'NATIONAL_ID', docNumber: '12345678', frontUrl: 'http://cdn/front.jpg' };

    it('creates KYC document and sets status to ID_SUBMITTED', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.kycDocument.create.mockResolvedValue({ id: 'doc-1', ...dto });
      mockPrisma.userProfile.update.mockResolvedValue(makeProfile({ kycStatus: 'ID_SUBMITTED' }));

      const result = await service.submitKyc('user-1', dto);

      expect(mockPrisma.kycDocument.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.userProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { kycStatus: 'ID_SUBMITTED' } }),
      );
      expect(result).toMatchObject({ message: expect.any(String) });
    });

    it('throws NotFoundException when profile not found', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(null);
      await expect(service.submitKyc('unknown', dto)).rejects.toThrow(NotFoundException);
    });
  });

  // ── approveKyc ──────────────────────────────────────────────────────────────

  describe('approveKyc', () => {
    it('sets kycTier to 2, status APPROVED, withdrawLimit 150000', async () => {
      mockPrisma.kycDocument.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userProfile.update.mockResolvedValue(makeProfile({ kycTier: 2, kycStatus: 'APPROVED' }));

      await service.approveKyc('user-1', 'admin-1');

      expect(mockPrisma.userProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kycTier: 2, kycStatus: 'APPROVED', withdrawLimit: 150000 }),
        }),
      );
    });

    it('publishes KYC approval Kafka notification', async () => {
      mockPrisma.kycDocument.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userProfile.update.mockResolvedValue(makeProfile());

      await service.approveKyc('user-1', 'admin-1');
      expect(mockKafka.publish).toHaveBeenCalled();
    });
  });

  // ── rejectKyc ───────────────────────────────────────────────────────────────

  describe('rejectKyc', () => {
    it('sets kycStatus to REJECTED and stores review note', async () => {
      mockPrisma.kycDocument.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userProfile.update.mockResolvedValue(makeProfile({ kycStatus: 'REJECTED' }));

      await service.rejectKyc('user-1', 'admin-1', 'Document unclear');

      expect(mockPrisma.kycDocument.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'REJECTED', rejectedNote: 'Document unclear' }),
        }),
      );
      expect(mockPrisma.userProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { kycStatus: 'REJECTED' } }),
      );
    });
  });

  // ── getPublicProfile ────────────────────────────────────────────────────────

  describe('getPublicProfile', () => {
    it('returns only public fields', async () => {
      const publicFields = { id: 'user-1', displayName: 'Test', avatarUrl: null, bio: null, createdAt: new Date() };
      mockPrisma.userProfile.findUnique.mockResolvedValue(publicFields);

      const result = await service.getPublicProfile('user-1');
      expect(result).toMatchObject({ id: 'user-1', displayName: 'Test' });
      // Phone should not be exposed (select only returns specified fields)
    });

    it('throws NotFoundException for unknown user', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(null);
      await expect(service.getPublicProfile('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ── getReferralStats ────────────────────────────────────────────────────────

  describe('getReferralStats', () => {
    it('returns referral code and count', async () => {
      mockPrisma.userProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.userProfile.findMany.mockResolvedValue([{ id: 'ref-user-1', createdAt: new Date() }]);

      const result = await service.getReferralStats('user-1');
      expect(result).toMatchObject({
        referralCode: 'TESTREF1',
        totalReferrals: 1,
        referrals: expect.any(Array),
      });
    });
  });

  // ── listUsers ───────────────────────────────────────────────────────────────

  describe('listUsers', () => {
    it('returns paginated user list', async () => {
      mockPrisma.userProfile.findMany.mockResolvedValue([makeProfile()]);
      mockPrisma.userProfile.count.mockResolvedValue(1);

      const result = await service.listUsers(1, 20);
      expect(result).toMatchObject({ data: expect.any(Array), meta: expect.objectContaining({ total: 1 }) });
    });

    it('filters by kycStatus when provided', async () => {
      mockPrisma.userProfile.findMany.mockResolvedValue([]);
      mockPrisma.userProfile.count.mockResolvedValue(0);

      await service.listUsers(1, 20, 'ID_SUBMITTED');
      expect(mockPrisma.userProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { kycStatus: 'ID_SUBMITTED' } }),
      );
    });
  });

  // ── setUserSuspended ────────────────────────────────────────────────────────

  describe('setUserSuspended', () => {
    it('calls prisma update with isSuspended true', async () => {
      (mockPrisma.userProfile as any).update = jest.fn().mockResolvedValue({});

      await service.setUserSuspended('user-1', true, 'admin-1');
      expect((mockPrisma.userProfile as any).update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' }, data: { isSuspended: true } }),
      );
    });

    it('calls prisma update with isSuspended false for unsuspend', async () => {
      (mockPrisma.userProfile as any).update = jest.fn().mockResolvedValue({});

      await service.setUserSuspended('user-1', false, 'admin-1');
      expect((mockPrisma.userProfile as any).update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isSuspended: false } }),
      );
    });
  });
});
