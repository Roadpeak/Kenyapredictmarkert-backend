import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from '@org/kafka-client';
import * as bcrypt from 'bcryptjs';
import * as utils from '@org/utils';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  otpCode: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  session: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};

const mockJwt = { sign: jest.fn().mockReturnValue('signed-access-token') };
const mockConfig = { get: jest.fn((key: string, def?: string) => def ?? 'development') };
const mockKafka = { publish: jest.fn().mockResolvedValue(undefined) };

jest.mock('@org/utils', () => ({
  normalizePhone: jest.fn((p: string) => p.replace(/^0/, '254')),
  generateOtp: jest.fn().mockReturnValue('123456'),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-value'),
  compare: jest.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeUser = (overrides = {}) => ({
  id: 'user-1',
  phone: '254712345678',
  email: null,
  passwordHash: 'hashed-password',
  role: 'USER',
  isVerified: true,
  isActive: true,
  createdAt: new Date(),
  ...overrides,
});

const makeOtp = (overrides = {}) => ({
  id: 'otp-1',
  userId: 'user-1',
  code: 'hashed-otp',
  purpose: 'PHONE_VERIFY',
  usedAt: null,
  expiresAt: new Date(Date.now() + 300_000),
  createdAt: new Date(),
  ...overrides,
});

const makeSession = (overrides = {}) => ({
  id: 'session-1',
  userId: 'user-1',
  refreshToken: 'valid-refresh-token',
  revokedAt: null,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
  user: makeUser(),
  ...overrides,
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: KafkaService, useValue: mockKafka },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe('register', () => {
    const dto = { phone: '0712345678', password: 'Password123' };

    it('creates user and returns phone + message', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(makeUser());
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue(makeOtp());

      const result = await service.register(dto);

      expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('user-registered'),
        expect.objectContaining({ userId: 'user-1' }),
      );
      expect(result).toMatchObject({ phone: expect.any(String) });
    });

    it('throws ConflictException when phone already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      await expect(service.register(dto)).rejects.toThrow(ConflictException);
    });

    it('hashes password before saving', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(makeUser());
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue(makeOtp());

      await service.register(dto);

      expect(bcrypt.hash).toHaveBeenCalledWith('Password123', 12);
    });
  });

  // ── verifyPhone ─────────────────────────────────────────────────────────────

  describe('verifyPhone', () => {
    const dto = { phone: '0712345678', otp: '123456' };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser({ isVerified: false }));
      mockPrisma.otpCode.findFirst.mockResolvedValue(makeOtp());
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue(makeUser({ isVerified: true }));
      mockPrisma.session.create.mockResolvedValue({});
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    });

    it('returns accessToken + refreshToken on valid OTP', async () => {
      const result = await service.verifyPhone(dto);
      expect(result).toMatchObject({ accessToken: 'signed-access-token', refreshToken: expect.any(String) });
    });

    it('marks user as verified in DB', async () => {
      await service.verifyPhone(dto);
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isVerified: true } }),
      );
    });

    it('publishes AUTH_USER_VERIFIED Kafka event', async () => {
      await service.verifyPhone(dto);
      expect(mockKafka.publish).toHaveBeenCalledWith(
        expect.stringContaining('user-verified'),
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('throws BadRequestException on expired/missing OTP', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyPhone(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException on wrong OTP value', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.verifyPhone(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws UnauthorizedException when phone not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.verifyPhone(dto)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── login ───────────────────────────────────────────────────────────────────

  describe('login', () => {
    const dto = { phone: '0712345678', password: 'Password123' };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockPrisma.session.create.mockResolvedValue({});
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    });

    it('returns tokens on valid credentials', async () => {
      const result = await service.login(dto);
      expect(result).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    });

    it('throws UnauthorizedException on wrong password', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when account is suspended', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));
      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws BadRequestException when phone not verified', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser({ isVerified: false }));
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue(makeOtp());
      await expect(service.login(dto)).rejects.toThrow(BadRequestException);
    });

    it('stores session with ipAddress and userAgent', async () => {
      await service.login(dto, '1.2.3.4', 'TestBrowser/1.0');
      expect(mockPrisma.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ipAddress: '1.2.3.4', userAgent: 'TestBrowser/1.0' }),
        }),
      );
    });
  });

  // ── refresh ─────────────────────────────────────────────────────────────────

  describe('refresh', () => {
    const dto = { refreshToken: 'valid-refresh-token' };

    it('rotates refresh token and returns new pair', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(makeSession());
      mockPrisma.session.update.mockResolvedValue({});
      mockPrisma.session.create.mockResolvedValue({});

      const result = await service.refresh(dto);
      expect(result).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
      expect(mockPrisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
      );
    });

    it('throws UnauthorizedException on invalid token', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);
      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException on revoked token', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException on expired token', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(
        makeSession({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user is suspended', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(
        makeSession({ user: makeUser({ isActive: false }) }),
      );
      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── logout ──────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('revokes session and returns success message', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.logout('some-refresh-token');
      expect(mockPrisma.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { refreshToken: 'some-refresh-token' },
          data: { revokedAt: expect.any(Date) },
        }),
      );
      expect(result.message).toBeDefined();
    });
  });

  // ── requestOtp ──────────────────────────────────────────────────────────────

  describe('requestOtp', () => {
    const dto = { phone: '0712345678', purpose: 'PHONE_VERIFY' };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockPrisma.otpCode.count.mockResolvedValue(0);
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue(makeOtp());
    });

    it('sends OTP and returns success message', async () => {
      const result = await service.requestOtp(dto);
      expect(result).toMatchObject({ message: expect.any(String) });
    });

    it('throws BadRequestException when rate limit exceeded (≥3 OTPs/hour)', async () => {
      mockPrisma.otpCode.count.mockResolvedValue(3);
      await expect(service.requestOtp(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for invalid purpose', async () => {
      await expect(service.requestOtp({ phone: '0712345678', purpose: 'INVALID_PURPOSE' }))
        .rejects.toThrow(BadRequestException);
    });

    it('throws UnauthorizedException when phone not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.requestOtp(dto)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── requestPasswordReset ────────────────────────────────────────────────────

  describe('requestPasswordReset', () => {
    it('always returns 200-style message regardless of whether phone exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.requestPasswordReset('0712345678');
      expect(result).toMatchObject({ message: expect.any(String) });
    });

    it('sends OTP when user exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue(makeOtp());
      await service.requestPasswordReset('0712345678');
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
    });
  });

  // ── resetPassword ───────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    const dto = { phone: '0712345678', otp: '123456', newPassword: 'NewPass123' };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockPrisma.otpCode.findFirst.mockResolvedValue(makeOtp({ purpose: 'PASSWORD_RESET' }));
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.session.updateMany.mockResolvedValue({ count: 1 });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    });

    it('updates password hash and revokes all sessions', async () => {
      const result = await service.resetPassword(dto);
      expect(bcrypt.hash).toHaveBeenCalledWith('NewPass123', 12);
      expect(mockPrisma.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
      );
      expect(result).toMatchObject({ message: expect.any(String) });
    });

    it('throws BadRequestException on invalid OTP', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.resetPassword(dto)).rejects.toThrow(BadRequestException);
    });
  });
});
