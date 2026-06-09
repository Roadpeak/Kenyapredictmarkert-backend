import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';
import {
  RegisterDto,
  VerifyPhoneDto,
  LoginDto,
  RefreshTokenDto,
  RequestOtpDto,
  ResetPasswordDto,
} from './auth.dto';
import { Role, OtpPurpose, JwtPayload } from '@org/types';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { normalizePhone, generateOtp } from '@org/utils';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly kafka: KafkaService,
  ) {}

  // ─── Register ────────────────────────────────────────────────────────────────

  async register(dto: RegisterDto) {
    const phone = normalizePhone(dto.phone);

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ConflictException('A user with this phone number already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        phone,
        email: dto.email ?? null,
        passwordHash,
        isVerified: false,
        role: Role.USER,
      },
    });

    // Send OTP for phone verification
    const otp = await this.createOtp(user.id, OtpPurpose.PHONE_VERIFY);
    await this.dispatchOtp(phone, otp, 'Your PredictMarket verification code');

    // Notify user-service to create profile
    await this.kafka.publish(KAFKA_TOPICS.AUTH_USER_REGISTERED, {
      userId: user.id,
      phone: user.phone,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
    });

    this.logger.log(`User registered: ${user.id}`);

    return {
      userId: user.id,
      phone: user.phone,
      message: 'Registration successful. Enter the OTP sent to your phone.',
    };
  }

  // ─── Verify Phone ────────────────────────────────────────────────────────────

  async verifyPhone(dto: VerifyPhoneDto) {
    const phone = normalizePhone(dto.phone);
    const user = await this.findUserByPhoneOrThrow(phone);

    await this.validateOtp(user.id, dto.otp, OtpPurpose.PHONE_VERIFY);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true },
    });

    await this.kafka.publish(KAFKA_TOPICS.AUTH_USER_VERIFIED, {
      userId: user.id,
      phone: user.phone,
    });

    const tokens = await this.issueTokens(user.id, user.phone, user.role as Role);

    this.logger.log(`Phone verified: ${user.id}`);
    return tokens;
  }

  // ─── Login ───────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string) {
    const phone = normalizePhone(dto.phone);
    const user = await this.findUserByPhoneOrThrow(phone);

    if (!user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid phone number or password');
    }

    if (!user.isVerified) {
      // Resend OTP silently
      const otp = await this.createOtp(user.id, OtpPurpose.PHONE_VERIFY);
      await this.dispatchOtp(phone, otp, 'Your PredictMarket verification code');
      throw new BadRequestException(
        'Phone not verified. A new OTP has been sent to your phone.',
      );
    }

    const tokens = await this.issueTokens(user.id, user.phone, user.role as Role, {
      ipAddress,
      userAgent,
    });

    await this.kafka.publish(KAFKA_TOPICS.AUTH_SESSION_CREATED, {
      userId: user.id,
      phone: user.phone,
    });

    return tokens;
  }

  // ─── Refresh Token ───────────────────────────────────────────────────────────

  async refresh(dto: RefreshTokenDto) {
    const session = await this.prisma.session.findUnique({
      where: { refreshToken: dto.refreshToken },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!session.user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }

    // Rotate refresh token
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(session.user.id, session.user.phone, session.user.role as Role);
  }

  // ─── Logout ──────────────────────────────────────────────────────────────────

  async logout(refreshToken: string) {
    await this.prisma.session.updateMany({
      where: { refreshToken },
      data: { revokedAt: new Date() },
    });
    return { message: 'Logged out successfully' };
  }

  // ─── Request OTP ─────────────────────────────────────────────────────────────

  async requestOtp(dto: RequestOtpDto) {
    const phone = normalizePhone(dto.phone);
    const user = await this.findUserByPhoneOrThrow(phone);

    const purpose = dto.purpose as OtpPurpose;
    if (!Object.values(OtpPurpose).includes(purpose)) {
      throw new BadRequestException('Invalid OTP purpose');
    }

    // Rate limit: max 3 OTPs per phone per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await this.prisma.otpCode.count({
      where: {
        userId: user.id,
        purpose,
        createdAt: { gte: oneHourAgo },
      },
    });

    if (recentCount >= 3) {
      throw new BadRequestException('Too many OTP requests. Please wait before requesting again.');
    }

    const otp = await this.createOtp(user.id, purpose);
    await this.dispatchOtp(phone, otp, 'Your PredictMarket code');

    return { message: 'OTP sent to your phone' };
  }

  // ─── Reset Password ──────────────────────────────────────────────────────────

  async requestPasswordReset(phone: string) {
    const normalized = normalizePhone(phone);
    const user = await this.prisma.user.findUnique({ where: { phone: normalized } });

    // Always return 200 — don't reveal if phone exists
    if (user) {
      const otp = await this.createOtp(user.id, OtpPurpose.PASSWORD_RESET);
      await this.dispatchOtp(normalized, otp, 'Your PredictMarket password reset code');
    }

    return { message: 'If that number is registered, an OTP has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const phone = normalizePhone(dto.phone);
    const user = await this.findUserByPhoneOrThrow(phone);

    await this.validateOtp(user.id, dto.otp, OtpPurpose.PASSWORD_RESET);

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Revoke all existing sessions
    await this.prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'Password reset successful. Please log in.' };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private async findUserByPhoneOrThrow(phone: string) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      throw new UnauthorizedException('Invalid phone number or password');
    }
    return user;
  }

  private async createOtp(userId: string, purpose: OtpPurpose): Promise<string> {
    // Invalidate existing OTPs for this purpose
    await this.prisma.otpCode.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });

    const code = generateOtp();
    const hash = await bcrypt.hash(code, 4); // Fast hash — OTP has short TTL
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await this.prisma.otpCode.create({
      data: { userId, code: hash, purpose, expiresAt },
    });

    return code;
  }

  private async validateOtp(userId: string, code: string, purpose: OtpPurpose) {
    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        userId,
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      throw new BadRequestException('Invalid or expired OTP code');
    }

    const valid = await bcrypt.compare(code, otpRecord.code);
    if (!valid) {
      throw new BadRequestException('Invalid or expired OTP code');
    }

    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { usedAt: new Date() },
    });
  }

  private async issueTokens(
    userId: string,
    phone: string,
    role: Role,
    sessionMeta?: { ipAddress?: string; userAgent?: string },
  ) {
    // Fetch kycTier from user-service is not available here —
    // embed 0 at login; will be updated on token refresh after KYC events
    const payload: JwtPayload = {
      sub: userId,
      phone,
      role,
      kycTier: 0,
      jti: randomBytes(16).toString('hex'),
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN', '15m'),
      algorithm: 'RS256',
    });

    const refreshToken = randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.prisma.session.create({
      data: {
        userId,
        refreshToken,
        expiresAt,
        ipAddress: sessionMeta?.ipAddress,
        userAgent: sessionMeta?.userAgent,
      },
    });

    return { accessToken, refreshToken, tokenType: 'Bearer' };
  }

  private async dispatchOtp(phone: string, otp: string, prefix: string) {
    // In dev: log to console. In prod: Africa's Talking via notification-service
    if (this.config.get('NODE_ENV') !== 'production') {
      this.logger.debug(`OTP for ${phone}: ${otp}`);
      return;
    }

    await this.kafka.publish(KAFKA_TOPICS.NOTIFICATION_SEND_SMS, {
      userId: 'system',
      phone,
      message: `${prefix}: ${otp}. Valid for 5 minutes. Do not share.`,
      notificationType: 'GENERAL',
    });
  }
}
