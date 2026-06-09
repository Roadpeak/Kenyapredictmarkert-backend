import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService, KAFKA_TOPICS } from '@org/kafka-client';
import { generateReferralCode } from '@org/utils';
import { UserRegisteredPayload } from '@org/types';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  // ─── Called by Kafka consumer when auth-service registers a user ─────────────

  async createProfile(payload: UserRegisteredPayload) {
    const existing = await this.prisma.userProfile.findUnique({
      where: { id: payload.userId },
    });
    if (existing) return; // Idempotent

    let referralCode = generateReferralCode();
    // Ensure uniqueness
    while (await this.prisma.userProfile.findFirst({ where: { referralCode } })) {
      referralCode = generateReferralCode();
    }

    await this.prisma.userProfile.create({
      data: {
        id: payload.userId,
        phone: payload.phone,
        referralCode,
        kycTier: 0,
      },
    });

    this.logger.log(`Profile created for user: ${payload.userId}`);
  }

  // ─── Get own profile ──────────────────────────────────────────────────────────

  async getMyProfile(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { id: userId },
      include: { preference: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  // ─── Update own profile ───────────────────────────────────────────────────────

  async updateMyProfile(userId: string, dto: { displayName?: string; bio?: string }) {
    const profile = await this.prisma.userProfile.findUnique({ where: { id: userId } });
    if (!profile) throw new NotFoundException('Profile not found');

    return this.prisma.userProfile.update({
      where: { id: userId },
      data: {
        displayName: dto.displayName,
        bio: dto.bio,
      },
    });
  }

  // ─── KYC ────────────────────────────────────────────────────────────────────

  async getKycStatus(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { id: userId },
      include: { kycDocuments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!profile) throw new NotFoundException('Profile not found');

    return {
      kycStatus: profile.kycStatus,
      kycTier: profile.kycTier,
      withdrawLimit: profile.withdrawLimit,
      depositLimit: profile.depositLimit,
      latestDocument: profile.kycDocuments[0] ?? null,
    };
  }

  async submitKyc(
    userId: string,
    dto: { docType: string; docNumber?: string; frontUrl?: string; backUrl?: string; selfieUrl?: string },
  ) {
    const profile = await this.prisma.userProfile.findUnique({ where: { id: userId } });
    if (!profile) throw new NotFoundException('Profile not found');

    const doc = await this.prisma.kycDocument.create({
      data: {
        userId,
        docType: dto.docType as any,
        docNumber: dto.docNumber,
        frontUrl: dto.frontUrl,
        backUrl: dto.backUrl,
        selfieUrl: dto.selfieUrl,
        status: 'PENDING',
      },
    });

    await this.prisma.userProfile.update({
      where: { id: userId },
      data: { kycStatus: 'ID_SUBMITTED' },
    });

    // Notify admin-service via Kafka
    await this.kafka.publish(KAFKA_TOPICS.ANALYTICS_MARKET_EVENT, {
      event: 'kyc.document.submitted',
      userId,
      docId: doc.id,
      docType: dto.docType,
    });

    return { message: 'KYC documents submitted. Review takes 1-3 business days.' };
  }

  // ─── Admin: approve/reject KYC ───────────────────────────────────────────────

  async approveKyc(userId: string, adminId: string) {
    await this.prisma.kycDocument.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date() },
    });

    await this.prisma.userProfile.update({
      where: { id: userId },
      data: {
        kycStatus: 'APPROVED',
        kycTier: 2,
        withdrawLimit: 150000,
      },
    });

    await this.kafka.publish(KAFKA_TOPICS.NOTIFICATION_SEND_SMS, {
      userId,
      phone: '',
      message: 'Your identity verification has been approved. You can now withdraw up to KES 150,000/day.',
      notificationType: 'KYC_APPROVED',
    });

    this.logger.log(`KYC approved for user: ${userId}`);
    return { message: 'KYC approved' };
  }

  async rejectKyc(userId: string, adminId: string, note: string) {
    await this.prisma.kycDocument.updateMany({
      where: { userId, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectedNote: note,
      },
    });

    await this.prisma.userProfile.update({
      where: { id: userId },
      data: { kycStatus: 'REJECTED' },
    });

    return { message: 'KYC rejected' };
  }

  // ─── Public profile ───────────────────────────────────────────────────────────

  async getPublicProfile(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        createdAt: true,
      },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  // ─── Referrals ────────────────────────────────────────────────────────────────

  async getReferralStats(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({ where: { id: userId } });
    if (!profile) throw new NotFoundException('Profile not found');

    const referrals = await this.prisma.userProfile.findMany({
      where: { referredBy: profile.referralCode },
      select: { id: true, createdAt: true },
    });

    return {
      referralCode: profile.referralCode,
      totalReferrals: referrals.length,
      referrals,
    };
  }

  // ─── Admin: list users ────────────────────────────────────────────────────────

  async listUsers(page = 1, limit = 20, kycStatus?: string) {
    const skip = (page - 1) * limit;
    const where = kycStatus ? { kycStatus: kycStatus as any } : {};

    const [data, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.userProfile.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async setUserSuspended(userId: string, suspended: boolean, adminId: string) {
    this.logger.log(`Admin ${adminId} ${suspended ? 'suspended' : 'unsuspended'} user ${userId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.prisma.userProfile as any).update({
      where: { id: userId },
      data: { isSuspended: suspended },
    });
    return { success: true };
  }

  // ─── Listen to Kafka events ───────────────────────────────────────────────────

  async startKafkaConsumers() {
    await this.kafka.subscribe<UserRegisteredPayload>(
      'user-service-group',
      [KAFKA_TOPICS.AUTH_USER_REGISTERED],
      async (_topic, payload) => {
        await this.createProfile(payload);
      },
    );
  }
}
