import {
  Controller, Get, Query, Post, Body, HttpCode, HttpStatus, Headers, UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service';
import { CurrentUser, Public } from '@org/decorators';
import type { JwtPayload } from '@org/types';
import { LedgerType } from '@org/types';

@ApiTags('wallet')
@Controller()
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly config: ConfigService,
  ) {}

  @Get('wallet/me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get own wallet balance' })
  getWallet(@CurrentUser() user: JwtPayload) {
    return this.walletService.getWallet(user.sub);
  }

  @Get('wallet/me/ledger')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Transaction history' })
  getLedger(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.walletService.getLedger(user.sub, +page, +limit);
  }

  // ─── Internal endpoints (service-to-service only) ─────────────────────────────

  @Public()
  @Post('internal/wallet/credit')
  @HttpCode(HttpStatus.OK)
  credit(
    @Body() body: { userId: string; amount: number; referenceId: string; referenceType: string; description?: string },
    @Headers('x-internal-key') key: string,
  ) {
    this.validateInternalKey(key);
    return this.walletService.credit(
      body.userId,
      body.amount,
      LedgerType.DEPOSIT,
      body.referenceId,
      body.referenceType,
      body.description,
    );
  }

  @Public()
  @Post('internal/wallet/debit')
  @HttpCode(HttpStatus.OK)
  debit(
    @Body() body: { userId: string; amount: number; referenceId: string; referenceType: string; description?: string },
    @Headers('x-internal-key') key: string,
  ) {
    this.validateInternalKey(key);
    return this.walletService.debit(
      body.userId,
      body.amount,
      LedgerType.TRADE_DEBIT,
      body.referenceId,
      body.referenceType,
      body.description,
    );
  }

  @Public()
  @Post('internal/wallet/reserve')
  @HttpCode(HttpStatus.OK)
  reserve(
    @Body() body: { userId: string; amount: number; referenceId: string },
    @Headers('x-internal-key') key: string,
  ) {
    this.validateInternalKey(key);
    return this.walletService.reserve(body.userId, body.amount, body.referenceId);
  }

  @Public()
  @Post('internal/wallet/release')
  @HttpCode(HttpStatus.OK)
  release(
    @Body() body: { userId: string; amount: number; referenceId: string },
    @Headers('x-internal-key') key: string,
  ) {
    this.validateInternalKey(key);
    return this.walletService.releaseReserve(body.userId, body.amount, body.referenceId);
  }

  private validateInternalKey(key: string) {
    const expected = this.config.get('INTERNAL_API_KEY');
    if (!expected || key !== expected) {
      throw new UnauthorizedException('Invalid internal API key');
    }
  }
}
