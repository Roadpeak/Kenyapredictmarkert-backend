import { Injectable, Logger, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from './prisma.service';
import { CreateCommentDto } from './comments.dto';

// No other request in this comment thread from the same user is accepted
// within this window — the only spam guard anywhere in this codebase
// (nothing else exists to reuse), so kept deliberately simple: one indexed
// query, no new infrastructure.
const COOLDOWN_MS = 15_000;

interface CommentRow {
  id: string;
  marketId: string;
  userId: string;
  body: string | null;
  parentId: string | null;
  createdAt: Date;
  displayName: string;
  replies?: CommentRow[];
}

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  // ─── Public reads ───────────────────────────────────────────────────────────

  async listForMarket(marketId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [topLevel, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { marketId, parentId: null, hiddenAt: null, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.comment.count({
        where: { marketId, parentId: null, hiddenAt: null, deletedAt: null },
      }),
    ]);

    const topLevelIds = topLevel.map((c) => c.id);
    const replies = topLevelIds.length
      ? await this.prisma.comment.findMany({
          where: { parentId: { in: topLevelIds }, hiddenAt: null, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const allUserIds = [...topLevel.map((c) => c.userId), ...replies.map((c) => c.userId)];
    const displayNames = await this.resolveDisplayNames(allUserIds);

    const repliesByParent = new Map<string, CommentRow[]>();
    for (const r of replies) {
      const list = repliesByParent.get(r.parentId as string) ?? [];
      list.push({
        id: r.id,
        marketId: r.marketId,
        userId: r.userId,
        body: r.deletedAt ? null : r.body,
        parentId: r.parentId,
        createdAt: r.createdAt,
        displayName: displayNames.get(r.userId) ?? 'Trader',
      });
      repliesByParent.set(r.parentId as string, list);
    }

    const data: CommentRow[] = topLevel.map((c) => ({
      id: c.id,
      marketId: c.marketId,
      userId: c.userId,
      body: c.deletedAt ? null : c.body,
      parentId: c.parentId,
      createdAt: c.createdAt,
      displayName: displayNames.get(c.userId) ?? 'Trader',
      replies: repliesByParent.get(c.id) ?? [],
    }));

    return { data, total, page, limit };
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateCommentDto) {
    const lastComment = await this.prisma.comment.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (lastComment && Date.now() - lastComment.createdAt.getTime() < COOLDOWN_MS) {
      throw new BadRequestException('Please wait a moment before posting again.');
    }

    // Replies are capped at one level deep — a reply to a reply is rejected
    // rather than silently flattened, so the frontend never has to render
    // arbitrary nesting.
    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Comment not found');
      if (parent.parentId) {
        throw new BadRequestException('Replies can only be one level deep.');
      }
      if (parent.marketId !== dto.marketId) {
        throw new BadRequestException('Reply must belong to the same market as its parent.');
      }
    }

    return this.prisma.comment.create({
      data: {
        marketId: dto.marketId,
        userId,
        body: dto.body,
        parentId: dto.parentId ?? null,
      },
    });
  }

  async deleteOwn(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new ForbiddenException('Not your comment');

    await this.prisma.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Admin moderation ───────────────────────────────────────────────────────

  async adminHide(adminUserId: string, commentId: string) {
    await this.findCommentOrThrow(commentId);
    return this.prisma.comment.update({
      where: { id: commentId },
      data: { hiddenAt: new Date(), hiddenBy: adminUserId },
    });
  }

  async adminUnhide(commentId: string) {
    await this.findCommentOrThrow(commentId);
    return this.prisma.comment.update({
      where: { id: commentId },
      data: { hiddenAt: null, hiddenBy: null },
    });
  }

  async adminDelete(commentId: string) {
    await this.findCommentOrThrow(commentId);
    return this.prisma.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
  }

  async adminListModerationQueue(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [comments, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.comment.count({ where: { deletedAt: null } }),
    ]);

    const [displayNames, marketTitles] = await Promise.all([
      this.resolveDisplayNames(comments.map((c) => c.userId)),
      this.resolveMarketTitles(comments.map((c) => c.marketId)),
    ]);

    return {
      data: comments.map((c) => ({
        id: c.id,
        marketId: c.marketId,
        marketTitle: marketTitles.get(c.marketId) ?? c.marketId,
        userId: c.userId,
        displayName: displayNames.get(c.userId) ?? 'Trader',
        body: c.body,
        parentId: c.parentId,
        isHidden: !!c.hiddenAt,
        createdAt: c.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  private async findCommentOrThrow(commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    return comment;
  }

  // ─── Cross-service resolution ──────────────────────────────────────────────

  // Copied verbatim from trading-service's resolveDisplayNames — comments-service
  // owns no user data, so every commenter's name has to be resolved from
  // user-service on read.
  private async resolveDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return new Map();

    const userServiceUrl = this.config.get('USER_SERVICE_URL', 'http://localhost:3002');
    const internalKey = this.config.get('INTERNAL_API_KEY');
    try {
      const response = await firstValueFrom(
        this.http.get<Record<string, string>>(
          `${userServiceUrl}/api/internal/users/display-names`,
          { params: { ids: uniqueIds.join(',') }, headers: { 'x-internal-key': internalKey } },
        ),
      );
      return new Map(Object.entries(response.data));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to resolve display names: ${msg}`);
      return new Map();
    }
  }

  // Same pattern as resolveDisplayNames — used only by the admin moderation
  // queue, which shows a market title next to each comment.
  private async resolveMarketTitles(marketIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(marketIds)];
    if (uniqueIds.length === 0) return new Map();

    const marketServiceUrl = this.config.get('MARKET_SERVICE_URL', 'http://localhost:3003');
    try {
      const response = await firstValueFrom(
        this.http.get<Array<{ id: string; title: string }>>(
          `${marketServiceUrl}/api/markets/batch`,
          { params: { ids: uniqueIds.join(',') } },
        ),
      );
      return new Map(response.data.map((m) => [m.id, m.title]));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to resolve market titles: ${msg}`);
      return new Map();
    }
  }
}
