import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@org/decorators';
import { OtpPurpose } from '@org/types';
import { AuthService } from './auth.service';

/**
 * Service-to-service endpoints, called by other services with the shared
 * INTERNAL_API_KEY rather than a user JWT. No @Controller('auth') prefix —
 * kept separate from AuthController so the route lands at /api/internal/*,
 * matching the convention every other service's internal namespace uses
 * (e.g. wallet-service's /api/internal/wallet/*), and what its callers
 * actually request.
 */
@ApiTags('auth')
@Controller()
export class InternalController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('internal/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Internal] Verify an OTP for a given purpose — used by payment-service to confirm withdrawals' })
  verifyOtp(
    @Body() body: { userId: string; otp: string; purpose: string },
    @Headers('x-internal-key') key: string,
  ) {
    this.validateInternalKey(key);
    if (!Object.values(OtpPurpose).includes(body.purpose as OtpPurpose)) {
      throw new BadRequestException('Invalid OTP purpose');
    }
    return this.authService.verifyOtpInternal(body.userId, body.otp, body.purpose as OtpPurpose);
  }

  private validateInternalKey(key: string) {
    const expected = this.config.get('INTERNAL_API_KEY');
    if (!expected || key !== expected) {
      throw new UnauthorizedException('Invalid internal API key');
    }
  }
}
