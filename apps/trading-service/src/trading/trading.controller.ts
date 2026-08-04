import {
  Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { PlaceTradeDto, PlaceOptionTradeDto } from './trading.dto';
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

  @Get('trades/me/positions/options')
  @ApiOperation({ summary: 'Current open positions across all multi-outcome markets' })
  getMyOptionPositions(@CurrentUser() user: JwtPayload) {
    return this.tradingService.getMyOptionPositions(user.sub);
  }

  @Get('trades/me/options')
  @ApiOperation({ summary: 'Own multi-outcome market trade history' })
  getMyOptionTrades(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('marketId') marketId?: string,
  ) {
    return this.tradingService.getMyOptionTrades(user.sub, +page, +limit, marketId);
  }

  // ─── MULTI markets (pick-a-winner) ──────────────────────────────────────────

  @Public()
  @Get('trades/markets/:marketId/options')
  @ApiOperation({ summary: 'Live option prices for a multi-outcome market' })
  getOptionPrices(@Param('marketId') marketId: string) {
    return this.tradingService.getOptionPrices(marketId);
  }

  @Post('trades/options')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Buy shares in one option of a multi-outcome market' })
  placeOptionTrade(
    @CurrentUser() user: JwtPayload,
    @Body() dto: PlaceOptionTradeDto,
  ) {
    return this.tradingService.placeOptionTrade(user.sub, dto);
  }

  @Get('trades/me/positions/:marketId')
  @ApiOperation({ summary: 'Position in a specific market' })
  getMarketPosition(@CurrentUser() user: JwtPayload, @Param('marketId') marketId: string) {
    return this.tradingService.getMarketPosition(user.sub, marketId);
  }

  @Get('trades/me/positions/:marketId/options')
  @ApiOperation({ summary: 'Own positions in a specific multi-outcome market' })
  getMarketOptionPositions(@CurrentUser() user: JwtPayload, @Param('marketId') marketId: string) {
    return this.tradingService.getMarketOptionPositions(user.sub, marketId);
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
