import {
  Controller, Post, Get, Body, Param, Query, HttpCode, HttpStatus, Ip,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { InitiateDepositDto, InitiateWithdrawalDto } from './payment.dto';
import { CurrentUser, Public } from '@org/decorators';
import type { JwtPayload } from '@org/types';
import type { StkCallback, B2cResult, B2cTimeout } from '../mpesa/mpesa.types';

// Safaricom callback IPs — add to env for easy updates
const SAFARICOM_IPS = new Set([
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74', '196.201.212.69',
]);

@ApiTags('payments')
@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

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
    if (!SAFARICOM_IPS.has(ip)) {
      throw new Error(`Unauthorized callback IP: ${ip}`);
    }
  }
}
