import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FeedService } from './feed.service';
import { CurrentUser } from '@org/decorators';
import type { JwtPayload } from '@org/types';

@ApiTags('feed')
@ApiBearerAuth()
@Controller()
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  @Get('feed/activity')
  @ApiOperation({ summary: 'Get personal activity feed' })
  getActivityFeed(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.feedService.getUserFeed(user.sub, +page, +limit);
  }

  @Get('feed/discovery')
  @ApiOperation({ summary: 'Get market discovery feed (active markets by volume)' })
  getDiscoveryFeed(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.feedService.getDiscoveryFeed(+page, +limit);
  }
}
