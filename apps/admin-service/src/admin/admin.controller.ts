import {
  Controller, Get, Post, Param, Body, Query, UseGuards, HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdminService, CreateMarketDto, ResolveMarketDto } from './admin.service';
import { AdminGuard } from '../common/guards/admin.guard';

function extractToken(req: Request): string {
  return (req.headers['authorization'] ?? '').replace('Bearer ', '');
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Markets ────────────────────────────────────────────────────────────────

  @Get('markets')
  @ApiOperation({ summary: 'List all markets (admin)' })
  listMarkets(
    @Query('status') status: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Req() req: Request,
  ) {
    return this.adminService.listMarkets(status, +page, +limit, extractToken(req));
  }

  @Post('markets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new market' })
  createMarket(@Body() dto: CreateMarketDto, @Req() req: Request) {
    return this.adminService.createMarket(dto, extractToken(req));
  }

  @Post('markets/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a market (opens for trading)' })
  activateMarket(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.activateMarket(id, extractToken(req));
  }

  @Post('markets/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a market with winning outcome' })
  resolveMarket(@Param('id') id: string, @Body() dto: ResolveMarketDto, @Req() req: Request) {
    return this.adminService.resolveMarket(id, dto, extractToken(req));
  }

  @Post('markets/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a market and refund all positions' })
  cancelMarket(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.cancelMarket(id, extractToken(req));
  }

  // ─── KYC ────────────────────────────────────────────────────────────────────

  @Get('kyc/pending')
  @ApiOperation({ summary: 'List pending KYC submissions' })
  listPendingKyc(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Req() req: Request,
  ) {
    return this.adminService.listPendingKyc(+page, +limit, extractToken(req));
  }

  @Post('kyc/:userId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve KYC for a user (tier 2)' })
  approveKyc(@Param('userId') userId: string, @Req() req: Request) {
    return this.adminService.approveKyc(userId, extractToken(req));
  }

  @Post('kyc/:userId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject KYC submission' })
  rejectKyc(
    @Param('userId') userId: string,
    @Body() body: { reason: string },
    @Req() req: Request,
  ) {
    return this.adminService.rejectKyc(userId, body.reason, extractToken(req));
  }

  // ─── Users ──────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List users' })
  listUsers(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Req() req: Request,
  ) {
    return this.adminService.listUsers(+page, +limit, extractToken(req));
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get user detail' })
  getUser(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.getUser(id, extractToken(req));
  }

  @Post('users/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend user account' })
  suspendUser(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.suspendUser(id, extractToken(req));
  }

  @Post('users/:id/unsuspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unsuspend user account' })
  unsuspendUser(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.unsuspendUser(id, extractToken(req));
  }
}
