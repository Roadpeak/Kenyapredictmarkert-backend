import {
  Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { PlaceTradeDto } from './trading.dto';
import { CurrentUser, Public } from '@org/decorators';
import type { JwtPayload } from '@org/types';

@ApiTags('trades')
@ApiBearerAuth()
@Controller()
export class TradingController {
  constructor(private readonly tradingService: TradingService) {}

  @Post('trades')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Place a trade on a market' })
  placeTrade(@Body() dto: PlaceTradeDto, @CurrentUser() user: JwtPayload) {
    return this.tradingService.placeTrade(user.sub, dto);
  }

  @Get('trades/me')
  @ApiOperation({ summary: 'Own trade history' })
  getMyTrades(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('marketId') marketId?: string,
  ) {
    return this.tradingService.getMyTrades(user.sub, +page, +limit, marketId);
  }

  @Get('trades/me/positions')
  @ApiOperation({ summary: 'Current open positions' })
  getMyPositions(@CurrentUser() user: JwtPayload) {
    return this.tradingService.getMyPositions(user.sub);
  }

  @Get('trades/me/positions/:marketId')
  @ApiOperation({ summary: 'Position in a specific market' })
  getMarketPosition(@CurrentUser() user: JwtPayload, @Param('marketId') marketId: string) {
    return this.tradingService.getMarketPosition(user.sub, marketId);
  }

  @Public()
  @Get('trades/markets/:marketId')
  @ApiOperation({ summary: 'Public anonymized trade history for a market' })
  getMarketTrades(
    @Param('marketId') marketId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.tradingService.getMarketTrades(marketId, +page, +limit);
  }
}
