import { Controller, Get, Post, Patch, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { CurrentUser } from '@org/decorators';
import type { JwtPayload } from '@org/types';
import { IsString, IsNotEmpty } from 'class-validator';

class RegisterTokenDto {
  @IsString() @IsNotEmpty() declare token: string;
  @IsString() @IsNotEmpty() declare platform: string;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'Get in-app notifications' })
  getNotifications(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.notificationService.getForUser(user.sub, +page, +limit);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark notification as read' })
  markRead(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.notificationService.markRead(user.sub, id);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notificationService.markAllRead(user.sub);
  }

  @Post('device-tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register FCM device token' })
  registerToken(@Body() dto: RegisterTokenDto, @CurrentUser() user: JwtPayload) {
    return this.notificationService.registerDeviceToken(user.sub, dto.token, dto.platform);
  }
}
