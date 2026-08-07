import { Controller, Get, Post, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './comments.dto';
import { CurrentUser, Public, Roles } from '@org/decorators';
import { Role } from '@org/types';
import type { JwtPayload } from '@org/types';

@ApiTags('comments')
@ApiBearerAuth()
@Controller()
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get('comments/markets/:marketId')
  @Public()
  @ApiOperation({ summary: 'List comments (with one level of replies) for a market' })
  listForMarket(
    @Param('marketId') marketId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.commentsService.listForMarket(marketId, +page, +limit);
  }

  @Post('comments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post a comment or a one-level-deep reply' })
  create(@Body() dto: CreateCommentDto, @CurrentUser() user: JwtPayload) {
    return this.commentsService.create(user.sub, dto);
  }

  @Delete('comments/:id')
  @ApiOperation({ summary: 'Delete your own comment' })
  deleteOwn(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.commentsService.deleteOwn(user.sub, id);
  }

  // ─── Admin moderation ───────────────────────────────────────────────────────

  @Get('comments/admin/queue')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Moderation queue — every non-deleted comment, newest first' })
  adminQueue(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.commentsService.adminListModerationQueue(+page, +limit);
  }

  @Post('comments/admin/:id/hide')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Hide a comment' })
  adminHide(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.commentsService.adminHide(user.sub, id);
  }

  @Post('comments/admin/:id/unhide')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Unhide a comment' })
  adminUnhide(@Param('id') id: string) {
    return this.commentsService.adminUnhide(id);
  }

  @Delete('comments/admin/:id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[Admin] Delete any comment' })
  adminDelete(@Param('id') id: string) {
    return this.commentsService.adminDelete(id);
  }
}
