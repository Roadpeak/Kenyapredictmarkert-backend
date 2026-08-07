import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { AxiosHeaders, AxiosResponse } from 'axios';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from './prisma.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockHttp = { get: jest.fn() };

const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? 'http://localhost:3002'),
};

const mockPrisma = {
  comment: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
};

function axiosOk<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

const makeComment = (overrides = {}) => ({
  id: 'comment-1',
  marketId: 'market-1',
  userId: 'user-1',
  body: 'Great market!',
  parentId: null,
  hiddenAt: null,
  hiddenBy: null,
  deletedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CommentsService', () => {
  let service: CommentsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: HttpService, useValue: mockHttp },
        { provide: ConfigService, useValue: mockConfig },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a top-level comment when there is no recent comment from the user', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.create.mockResolvedValue(makeComment());

      const result = await service.create('user-1', { marketId: 'market-1', body: 'Great market!' });

      expect(mockPrisma.comment.create).toHaveBeenCalledWith({
        data: {
          marketId: 'market-1',
          userId: 'user-1',
          body: 'Great market!',
          gifUrl: null,
          gifId: null,
          stickerId: null,
          parentId: null,
        },
      });
      expect(result).toMatchObject({ body: 'Great market!' });
    });

    it('rejects a new comment posted within the cooldown window of the user\'s last one — the only spam guard in this codebase, kept to a single indexed query', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(
        makeComment({ createdAt: new Date(Date.now() - 5_000) }), // 5s ago, cooldown is 15s
      );

      await expect(
        service.create('user-1', { marketId: 'market-1', body: 'Another one' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('allows a new comment once the cooldown window has passed', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(
        makeComment({ createdAt: new Date(Date.now() - 20_000) }), // 20s ago, cooldown is 15s
      );
      mockPrisma.comment.create.mockResolvedValue(makeComment());

      await expect(
        service.create('user-1', { marketId: 'market-1', body: 'Another one' }),
      ).resolves.toBeDefined();
    });

    it('allows a reply to a top-level comment', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.findUnique.mockResolvedValue(makeComment({ id: 'parent-1', parentId: null }));
      mockPrisma.comment.create.mockResolvedValue(makeComment({ parentId: 'parent-1' }));

      await service.create('user-2', { marketId: 'market-1', body: 'I agree', parentId: 'parent-1' });

      expect(mockPrisma.comment.create).toHaveBeenCalledWith({
        data: {
          marketId: 'market-1',
          userId: 'user-2',
          body: 'I agree',
          gifUrl: null,
          gifId: null,
          stickerId: null,
          parentId: 'parent-1',
        },
      });
    });

    it('rejects a reply to a reply — nesting is capped at one level deep', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      // The "parent" being replied to is itself a reply (has its own parentId).
      mockPrisma.comment.findUnique.mockResolvedValue(
        makeComment({ id: 'reply-1', parentId: 'top-level-1' }),
      );

      await expect(
        service.create('user-3', { marketId: 'market-1', body: 'Nested reply', parentId: 'reply-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when replying to a comment that does not exist', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', { marketId: 'market-1', body: 'Reply', parentId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a reply whose parent belongs to a different market', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.findUnique.mockResolvedValue(
        makeComment({ id: 'parent-1', marketId: 'market-2', parentId: null }),
      );

      await expect(
        service.create('user-1', { marketId: 'market-1', body: 'Reply', parentId: 'parent-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a comment with both a gifUrl and a stickerId set', async () => {
      await expect(
        service.create('user-1', {
          marketId: 'market-1',
          gifUrl: 'https://media.giphy.com/foo.gif',
          stickerId: 'rocket',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.comment.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a comment with no body and no attachment', async () => {
      await expect(
        service.create('user-1', { marketId: 'market-1', body: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown stickerId', async () => {
      await expect(
        service.create('user-1', { marketId: 'market-1', stickerId: 'not-a-real-sticker' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('accepts a sticker-only comment with an empty body', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.create.mockResolvedValue(makeComment({ stickerId: 'rocket', body: '' }));

      await service.create('user-1', { marketId: 'market-1', stickerId: 'rocket' });

      expect(mockPrisma.comment.create).toHaveBeenCalledWith({
        data: {
          marketId: 'market-1',
          userId: 'user-1',
          body: '',
          gifUrl: null,
          gifId: null,
          stickerId: 'rocket',
          parentId: null,
        },
      });
    });

    it('accepts a gif-only comment and stores gifUrl/gifId', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.create.mockResolvedValue(
        makeComment({ gifUrl: 'https://media.giphy.com/foo.gif', body: '' }),
      );

      await service.create('user-1', {
        marketId: 'market-1',
        gifUrl: 'https://media.giphy.com/foo.gif',
        gifId: 'abc123',
      });

      expect(mockPrisma.comment.create).toHaveBeenCalledWith({
        data: {
          marketId: 'market-1',
          userId: 'user-1',
          body: '',
          gifUrl: 'https://media.giphy.com/foo.gif',
          gifId: 'abc123',
          stickerId: null,
          parentId: null,
        },
      });
    });

    it('accepts a captioned attachment (body + sticker together)', async () => {
      mockPrisma.comment.findFirst.mockResolvedValue(null);
      mockPrisma.comment.create.mockResolvedValue(makeComment({ stickerId: 'fire', body: 'lol' }));

      await service.create('user-1', { marketId: 'market-1', body: 'lol', stickerId: 'fire' });

      expect(mockPrisma.comment.create).toHaveBeenCalledWith({
        data: {
          marketId: 'market-1',
          userId: 'user-1',
          body: 'lol',
          gifUrl: null,
          gifId: null,
          stickerId: 'fire',
          parentId: null,
        },
      });
    });
  });

  // ── searchGifs ──────────────────────────────────────────────────────────────

  describe('searchGifs', () => {
    it('maps a Giphy response down to {id, url, previewUrl}', async () => {
      mockConfig.get.mockReturnValueOnce('test-giphy-key');
      (mockConfig as unknown as { getOrThrow: jest.Mock }).getOrThrow = jest.fn(() => 'test-giphy-key');
      mockHttp.get.mockReturnValue(
        of(
          axiosOk({
            data: [
              {
                id: 'gif-1',
                images: {
                  fixed_width: { url: 'https://media.giphy.com/gif-1/fixed_width.gif' },
                  fixed_width_small: { url: 'https://media.giphy.com/gif-1/fixed_width_small.gif' },
                  original: { url: 'https://media.giphy.com/gif-1/original.gif' },
                },
              },
            ],
          }),
        ),
      );

      const result = await service.searchGifs('celebration', 0);

      expect(result).toEqual([
        {
          id: 'gif-1',
          url: 'https://media.giphy.com/gif-1/fixed_width.gif',
          previewUrl: 'https://media.giphy.com/gif-1/fixed_width_small.gif',
        },
      ]);
    });

    it('throws InternalServerErrorException when the Giphy request fails', async () => {
      (mockConfig as unknown as { getOrThrow: jest.Mock }).getOrThrow = jest.fn(() => 'test-giphy-key');
      mockHttp.get.mockImplementation(() => {
        throw new Error('network error');
      });

      await expect(service.searchGifs('celebration')).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── deleteOwn ───────────────────────────────────────────────────────────────

  describe('deleteOwn', () => {
    it('soft-deletes a comment owned by the caller', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(makeComment({ userId: 'user-1' }));
      mockPrisma.comment.update.mockResolvedValue({});

      await service.deleteOwn('user-1', 'comment-1');

      expect(mockPrisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('throws ForbiddenException when the comment belongs to a different user', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(makeComment({ userId: 'user-1' }));

      await expect(service.deleteOwn('user-2', 'comment-1')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.comment.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a comment that does not exist', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(null);
      await expect(service.deleteOwn('user-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── listForMarket ───────────────────────────────────────────────────────────

  describe('listForMarket', () => {
    it('nests replies under their parent and resolves display names for both', async () => {
      mockPrisma.comment.findMany
        .mockResolvedValueOnce([makeComment({ id: 'top-1', userId: 'user-1' })]) // top-level
        .mockResolvedValueOnce([
          makeComment({ id: 'reply-1', userId: 'user-2', parentId: 'top-1', body: 'Nice one' }),
        ]); // replies
      mockPrisma.comment.count.mockResolvedValue(1);
      mockHttp.get.mockReturnValue(of(axiosOk({ 'user-1': 'Alice', 'user-2': 'Bob' })));

      const result = await service.listForMarket('market-1', 1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ id: 'top-1', displayName: 'Alice' });
      expect(result.data[0].replies).toEqual([
        expect.objectContaining({ id: 'reply-1', displayName: 'Bob', body: 'Nice one' }),
      ]);
      expect(result.total).toBe(1);
    });

    it('renders a soft-deleted comment\'s body as null rather than exposing a separate hidden flag to the frontend', async () => {
      mockPrisma.comment.findMany
        .mockResolvedValueOnce([makeComment({ id: 'top-1', deletedAt: new Date() })])
        .mockResolvedValueOnce([]);
      mockPrisma.comment.count.mockResolvedValue(1);
      mockHttp.get.mockReturnValue(of(axiosOk({})));

      const result = await service.listForMarket('market-1', 1, 20);
      expect(result.data[0].body).toBeNull();
    });

    it('skips the replies query entirely when there are no top-level comments', async () => {
      mockPrisma.comment.findMany.mockResolvedValueOnce([]);
      mockPrisma.comment.count.mockResolvedValue(0);

      const result = await service.listForMarket('market-1', 1, 20);

      expect(result.data).toEqual([]);
      expect(mockPrisma.comment.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── admin moderation ────────────────────────────────────────────────────────

  describe('admin moderation', () => {
    it('adminHide sets hiddenAt and hiddenBy', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(makeComment());
      mockPrisma.comment.update.mockResolvedValue({});

      await service.adminHide('admin-1', 'comment-1');

      expect(mockPrisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
        data: { hiddenAt: expect.any(Date), hiddenBy: 'admin-1' },
      });
    });

    it('adminUnhide clears hiddenAt and hiddenBy', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(makeComment({ hiddenAt: new Date() }));
      mockPrisma.comment.update.mockResolvedValue({});

      await service.adminUnhide('comment-1');

      expect(mockPrisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
        data: { hiddenAt: null, hiddenBy: null },
      });
    });

    it('adminDelete sets deletedAt regardless of ownership', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(makeComment({ userId: 'someone-else' }));
      mockPrisma.comment.update.mockResolvedValue({});

      await service.adminDelete('comment-1');

      expect(mockPrisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('adminListModerationQueue resolves both commenter names and market titles', async () => {
      mockPrisma.comment.findMany.mockResolvedValue([
        makeComment({ id: 'c1', userId: 'user-1', marketId: 'market-1' }),
      ]);
      mockPrisma.comment.count.mockResolvedValue(1);
      mockHttp.get
        .mockReturnValueOnce(of(axiosOk({ 'user-1': 'Alice' })))
        .mockReturnValueOnce(of(axiosOk([{ id: 'market-1', title: 'Will it rain?' }])));

      const result = await service.adminListModerationQueue(1, 20);

      expect(result.data[0]).toMatchObject({
        displayName: 'Alice',
        marketTitle: 'Will it rain?',
        isHidden: false,
      });
    });
  });
});
