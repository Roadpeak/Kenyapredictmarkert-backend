import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { CurrentUser, Roles } from '@org/decorators';
import type { JwtPayload } from '@org/types';
import { Role } from '@org/types';

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('users/me')
  @ApiOperation({ summary: 'Get own profile' })
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.userService.getMyProfile(user.sub);
  }

  @Put('users/me')
  @ApiOperation({ summary: 'Update profile (displayName, bio)' })
  updateMyProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: { displayName?: string; bio?: string },
  ) {
    return this.userService.updateMyProfile(user.sub, dto);
  }

  @Get('users/me/kyc')
  @ApiOperation({ summary: 'Get KYC status and tier' })
  getKycStatus(@CurrentUser() user: JwtPayload) {
    return this.userService.getKycStatus(user.sub);
  }

  @Post('users/me/kyc/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit KYC documents' })
  submitKyc(
    @CurrentUser() user: JwtPayload,
    @Body()
    dto: {
      docType: string;
      docNumber?: string;
      frontUrl?: string;
      backUrl?: string;
      selfieUrl?: string;
    },
  ) {
    return this.userService.submitKyc(user.sub, dto);
  }

  @Get('users/me/referrals')
  @ApiOperation({ summary: 'Get referral stats and code' })
  getReferralStats(@CurrentUser() user: JwtPayload) {
    return this.userService.getReferralStats(user.sub);
  }

  @Get('users/:id/profile')
  @ApiOperation({ summary: 'Get public profile' })
  getPublicProfile(@Param('id') id: string) {
    return this.userService.getPublicProfile(id);
  }

  // ─── Admin routes ─────────────────────────────────────────────────────────────

  @Get('admin/users')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] List users' })
  listUsers(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('kycStatus') kycStatus?: string,
  ) {
    return this.userService.listUsers(+page, +limit, kycStatus);
  }

  @Get('admin/users/:id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Get full user profile' })
  getAdminProfile(@Param('id') id: string) {
    return this.userService.getMyProfile(id);
  }

  @Put('admin/users/:id/kyc/approve')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Approve KYC' })
  approveKyc(@Param('id') id: string, @CurrentUser() admin: JwtPayload) {
    return this.userService.approveKyc(id, admin.sub);
  }

  @Put('admin/users/:id/kyc/reject')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Reject KYC' })
  rejectKyc(
    @Param('id') id: string,
    @CurrentUser() admin: JwtPayload,
    @Body('note') note: string,
  ) {
    return this.userService.rejectKyc(id, admin.sub, note);
  }

  @Get('admin/kyc/pending')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] List pending KYC submissions' })
  listPendingKyc(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.userService.listUsers(+page, +limit, 'ID_SUBMITTED');
  }

  @Post('admin/users/:id/suspend')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Suspend user' })
  suspendUser(@Param('id') id: string, @CurrentUser() admin: JwtPayload) {
    return this.userService.setUserSuspended(id, true, admin.sub);
  }

  @Post('admin/users/:id/unsuspend')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Unsuspend user' })
  unsuspendUser(@Param('id') id: string, @CurrentUser() admin: JwtPayload) {
    return this.userService.setUserSuspended(id, false, admin.sub);
  }
}
