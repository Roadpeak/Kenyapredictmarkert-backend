import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminGuard } from './admin.guard';
import { Role } from '@org/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockContext(authHeader?: string) {
  const request: Record<string, any> = { headers: {} };
  if (authHeader !== undefined) {
    request.headers['authorization'] = authHeader;
  }
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let jwtVerify: jest.SpyInstance;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => (key === 'JWT_PUBLIC_KEY' ? 'test-public-key' : undefined)),
    } as unknown as ConfigService;

    guard = new AdminGuard(config);

    // Spy on the internal JwtService that AdminGuard creates
    jwtVerify = jest.spyOn(JwtService.prototype, 'verify');
  });

  afterEach(() => {
    jwtVerify.mockRestore();
  });

  // ── No token ────────────────────────────────────────────────────────────────

  it('throws UnauthorizedException when no Authorization header', () => {
    expect(() => guard.canActivate(mockContext())).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when header does not start with Bearer', () => {
    expect(() => guard.canActivate(mockContext('Basic abc'))).toThrow(UnauthorizedException);
  });

  // ── Invalid token ───────────────────────────────────────────────────────────

  it('throws UnauthorizedException when JWT verification fails', () => {
    jwtVerify.mockImplementation(() => { throw new Error('invalid signature'); });
    expect(() => guard.canActivate(mockContext('Bearer bad-token'))).toThrow(UnauthorizedException);
  });

  // ── Non-admin role ──────────────────────────────────────────────────────────

  it('throws ForbiddenException when role is USER', () => {
    jwtVerify.mockReturnValue({ sub: 'user-1', role: Role.USER, kycTier: 0 });
    expect(() => guard.canActivate(mockContext('Bearer valid-user-token'))).toThrow(ForbiddenException);
  });

  // ── Admin roles ─────────────────────────────────────────────────────────────

  it('returns true and sets request.user for ADMIN role', () => {
    const payload = { sub: 'admin-1', role: Role.ADMIN, kycTier: 2 };
    jwtVerify.mockReturnValue(payload);

    const ctx = mockContext('Bearer admin-token');
    const result = guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(ctx.switchToHttp().getRequest().user).toEqual(payload);
  });

  it('returns true for SUPER_ADMIN role', () => {
    jwtVerify.mockReturnValue({ sub: 'super-1', role: Role.SUPER_ADMIN, kycTier: 2 });
    expect(guard.canActivate(mockContext('Bearer super-token'))).toBe(true);
  });
});
