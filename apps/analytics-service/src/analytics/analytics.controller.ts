import { Controller, Get, Param, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ─── Leaderboard ──────────────────────────────────────────────────────────

  @Get('leaderboard')
  @ApiOperation({ summary: 'Get paginated leaderboard' })
  @ApiQuery({ name: 'period', required: false, example: 'weekly', description: 'Leaderboard period identifier' })
  @ApiQuery({ name: 'category', required: false, example: 'OVERALL', description: 'Leaderboard category' })
  @ApiQuery({ name: 'page', required: false, example: 1, description: 'Page number (1-based)' })
  @ApiQuery({ name: 'limit', required: false, example: 20, description: 'Items per page' })
  getLeaderboard(
    @Query('period') period = 'weekly',
    @Query('category') category = 'OVERALL',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.analyticsService.getLeaderboard(period, category, page, limit);
  }

  // ─── Market Stats ─────────────────────────────────────────────────────────

  @Get('markets/:id/stats')
  @ApiOperation({ summary: 'Get volume stats for a market across all periods' })
  @ApiParam({ name: 'id', description: 'Market ID' })
  getMarketStats(@Param('id') id: string) {
    return this.analyticsService.getMarketStats(id);
  }

  // ─── User Stats ───────────────────────────────────────────────────────────

  @Get('users/:id/stats')
  @ApiOperation({ summary: 'Get aggregate trading stats for a user (admin or self)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  getUserStats(@Param('id') id: string) {
    return this.analyticsService.getUserStats(id);
  }
}
