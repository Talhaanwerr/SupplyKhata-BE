import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { CreateNotificationDto, NotificationType } from './dto/create-notification.dto';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

type NotificationItem = {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  body: string;
  type: NotificationType;
  isRead: boolean;
  readAt: Date | null;
  link: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Create (internal — called by other modules) ───────────────────────

  /**
   * Create an in-app notification for a user in this tenant.
   * Validates that the target user exists and belongs to the tenant.
   */
  async create(dto: CreateNotificationDto, tenantId: string): Promise<NotificationItem> {
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException(`User '${dto.userId}' not found`);
    }

    const member = await this.prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId: dto.userId, tenantId } },
      select: { userId: true },
    });
    if (!member) {
      throw new BadRequestException('User is not a member of this workspace');
    }

    const notification = await this.prisma.notification.create({
      data: {
        tenantId,
        userId: dto.userId,
        title: dto.title,
        body: dto.body,
        type: dto.type ?? NotificationType.INFO,
        link: dto.link ?? null,
      },
    });

    return notification as NotificationItem;
  }

  // ─── List (per user, tenant-scoped) ───────────────────────────────────

  async findAll(
    userId: string,
    tenantId: string,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedData<NotificationItem>> {
    const { skip, take } = getPaginationParams(query);

    const where: { userId: string; tenantId: string; isRead?: boolean } = {
      userId,
      tenantId,
    };

    if (query.unreadOnly) where.isRead = false;

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      items: items as NotificationItem[],
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  // ─── Unread count ──────────────────────────────────────────────────────

  async unreadCount(userId: string, tenantId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, tenantId, isRead: false },
    });
    return { count };
  }

  // ─── Mark as read ──────────────────────────────────────────────────────

  async markAsRead(id: string, userId: string, tenantId: string): Promise<NotificationItem> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId, tenantId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    const updated = await this.prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });

    return updated as NotificationItem;
  }

  // ─── Mark all as read ──────────────────────────────────────────────────

  async markAllAsRead(userId: string, tenantId: string): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, tenantId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    return { updated: result.count };
  }
}
