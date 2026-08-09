import {
  Controller, Get, Post, Param, Body, Query, UseGuards, UseInterceptors, UploadedFile,
  HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
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

  @Post('markets/:id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a market for trading (ACTIVE → CLOSED)' })
  closeMarket(@Param('id') id: string, @Req() req: Request) {
    return this.adminService.closeMarket(id, extractToken(req));
  }

  @Post('markets/:id/image')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update market image URL' })
  updateMarketImage(@Param('id') id: string, @Body('imageUrl') imageUrl: string, @Req() req: Request) {
    return this.adminService.updateMarketImage(id, imageUrl, extractToken(req));
  }

  @Post('markets/images')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiOperation({
    summary: 'Upload a market or option image to Cloudinary, returns { url }. ' +
      'Not tied to a specific market — used during creation before the market exists.',
  })
  uploadMarketImage(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    return this.adminService.uploadMarketImage(file, extractToken(req));
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
