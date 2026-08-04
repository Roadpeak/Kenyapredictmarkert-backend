import {
  Controller, Post, Get, Body, Param, Query, HttpCode, HttpStatus, Ip, ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { InitiateDepositDto, InitiateWithdrawalDto } from './payment.dto';
import { CurrentUser, Public, Roles } from '@org/decorators';
import type { JwtPayload } from '@org/types';
import { Role } from '@org/types';
import type { StkCallback, B2cResult, B2cTimeout } from '../mpesa/mpesa.types';

// Safaricom's published callback IPs (Daraja docs, "Whitelisting IPs"), used
// as the default. Override with MPESA_CALLBACK_IPS (comma-separated) if
// Safaricom updates the list — that shouldn't need a redeploy.
const DEFAULT_SAFARICOM_IPS = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74', '196.201.212.69',
];

@ApiTags('payments')
@Controller()
export class PaymentController {
  private readonly safaricomIps: Set<string>;

  constructor(
    private readonly paymentService: PaymentService,
    private readonly config: ConfigService,
  ) {
    const override = this.config.get<string>('MPESA_CALLBACK_IPS');
    const ips = override
      ? override.split(',').map((ip) => ip.trim()).filter(Boolean)
      : DEFAULT_SAFARICOM_IPS;
    this.safaricomIps = new Set(ips);
  }

  // ─── Deposits ─────────────────────────────────────────────────────────────────

  @Post('payments/deposits/initiate')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate M-Pesa STK Push deposit' })
  initiateDeposit(@Body() dto: InitiateDepositDto, @CurrentUser() user: JwtPayload) {
    return this.paymentService.initiateDeposit(user.sub, user.kycTier, dto);
  }

  @Get('payments/deposits/:id/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Poll deposit status' })
  getDepositStatus(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.paymentService.getPaymentStatus(id, user.sub);
  }

  @Get('payments/deposits')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deposit history' })
  getDeposits(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.paymentService.getDepositHistory(user.sub, +page, +limit);
  }

  // ─── Admin ────────────────────────────────────────────────────────────────────

  @Get('admin/payments')
  @ApiBearerAuth()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] All deposits and withdrawals across the platform' })
  getAllPayments(
    @Query('type') type?: 'DEPOSIT' | 'WITHDRAWAL',
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.paymentService.getAllPayments({ type, status, userId }, +page, +limit);
  }

  // ─── Withdrawals ──────────────────────────────────────────────────────────────

  @Post('payments/withdrawals/initiate')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate M-Pesa B2C withdrawal (requires OTP confirmation)' })
  initiateWithdrawal(@Body() dto: InitiateWithdrawalDto, @CurrentUser() user: JwtPayload) {
    return this.paymentService.initiateWithdrawal(user.sub, user.kycTier, dto);
  }

  @Get('payments/withdrawals/:id/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Poll withdrawal status' })
  getWithdrawalStatus(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.paymentService.getPaymentStatus(id, user.sub);
  }

  @Get('payments/withdrawals')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdrawal history' })
  getWithdrawals(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.paymentService.getWithdrawalHistory(user.sub, +page, +limit);
  }

  // ─── M-Pesa Callbacks (Safaricom → us, IP-whitelisted, no auth) ──────────────

  @Public()
  @Post('callbacks/mpesa/stk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Safaricom] STK Push result callback' })
  stkCallback(@Body() body: StkCallback, @Ip() ip: string) {
    this.validateSafaricomIp(ip);
    return this.paymentService.handleStkCallback(body);
  }

  @Public()
  @Post('callbacks/mpesa/b2c/result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Safaricom] B2C result callback' })
  b2cResultCallback(@Body() body: B2cResult, @Ip() ip: string) {
    this.validateSafaricomIp(ip);
    return this.paymentService.handleB2cResult(body);
  }

  @Public()
  @Post('callbacks/mpesa/b2c/timeout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Safaricom] B2C timeout callback' })
  b2cTimeoutCallback(@Body() body: B2cTimeout, @Ip() ip: string) {
    this.validateSafaricomIp(ip);
    return this.paymentService.handleB2cTimeout(body);
  }

  // ─── IP validation ────────────────────────────────────────────────────────────

  private validateSafaricomIp(ip: string) {
    // Skip validation in development
    if (process.env.NODE_ENV !== 'production') return;

    // Express reports IPv4-mapped IPv6 addresses (::ffff:196.201.214.200) on
    // some socket configurations — strip the prefix so the Set comparison
    // isn't silently always-false.
    const normalized = ip.replace(/^::ffff:/, '');

    if (!this.safaricomIps.has(normalized)) {
      // A plain Error here would surface as a 500; this is a rejected caller,
      // not a server fault.
      throw new ForbiddenException(`Unauthorized callback IP: ${normalized}`);
    }
  }
}
