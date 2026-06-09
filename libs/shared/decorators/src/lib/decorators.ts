import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { JwtPayload, Role } from '@org/types';

// ─── @CurrentUser ─────────────────────────────────────────────────────────────

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as JwtPayload;
  },
);

// ─── @Public ──────────────────────────────────────────────────────────────────

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

// ─── @Roles ───────────────────────────────────────────────────────────────────

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

// ─── @RequireKyc ─────────────────────────────────────────────────────────────

export const KYC_TIER_KEY = 'kycTier';
export const RequireKyc = (tier: number) => SetMetadata(KYC_TIER_KEY, tier);

// ─── @InternalOnly ───────────────────────────────────────────────────────────

export const IS_INTERNAL_KEY = 'isInternal';
export const InternalOnly = () => SetMetadata(IS_INTERNAL_KEY, true);
