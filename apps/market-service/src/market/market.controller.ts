import {
  Controller, Get, Post, Put, Param, Query, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MarketService } from './market.service';
import { CreateMarketDto, ResolveMarketDto, MarketQueryDto } from './market.dto';
import { CurrentUser, Roles, Public } from '@org/decorators';
import type { JwtPayload } from '@org/types';
import { Role } from '@org/types';

@ApiTags('markets')
@Controller()
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Public()
  @Get('markets')
  @ApiOperation({ summary: 'List markets with filters' })
  listMarkets(@Query() query: MarketQueryDto) {
    return this.marketService.listMarkets(query);
  }

  @Public()
  @Get('markets/categories')
  @ApiOperation({ summary: 'Get categories with active market counts' })
  getCategories() {
    return this.marketService.getCategories();
  }

  @Public()
  @Get('markets/:idOrSlug')
  @ApiOperation({ summary: 'Get market by id or slug' })
  getMarket(@Param('idOrSlug') idOrSlug: string) {
    return this.marketService.getMarket(idOrSlug);
  }

  @Public()
  @Get('markets/:id/history')
  @ApiOperation({ summary: 'Get price history for chart' })
  getPriceHistory(@Param('id') id: string, @Query('hours') hours = 24) {
    return this.marketService.getPriceHistory(id, +hours);
  }

  // ─── Admin routes ─────────────────────────────────────────────────────────────

  @Post('admin/markets')
  @ApiBearerAuth()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Create market' })
  createMarket(@Body() dto: CreateMarketDto, @CurrentUser() admin: JwtPayload) {
    return this.marketService.createMarket(dto, admin.sub);
  }

  @Put('admin/markets/:id/activate')
  @ApiBearerAuth()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Activate market (DRAFT → ACTIVE)' })
  activateMarket(@Param('id') id: string) {
    return this.marketService.activateMarket(id);
  }

  @Put('admin/markets/:id/close')
  @ApiBearerAuth()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Close market for trading' })
  closeMarket(@Param('id') id: string) {
    return this.marketService.closeMarket(id);
  }

  @Put('admin/markets/:id/resolve')
  @ApiBearerAuth()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Resolve market with outcome' })
  resolveMarket(
    @Param('id') id: string,
    @Body() dto: ResolveMarketDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.marketService.resolveMarket(id, dto, admin.sub);
  }

  @Put('admin/markets/:id/cancel')
  @ApiBearerAuth()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Cancel market and trigger refunds' })
  cancelMarket(@Param('id') id: string) {
    return this.marketService.cancelMarket(id);
  }
}
