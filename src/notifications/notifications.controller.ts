import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * GET /notifications — list own notifications (optionally unread only).
   */
  @Get()
  @RequirePermissions('notifications:read')
  findAll(
    @Query() query: ListNotificationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenantId: string,
  ) {
    return this.notificationsService.findAll(user.id, tenantId, query);
  }

  /**
   * GET /notifications/unread-count — quick unread badge count.
   */
  @Get('unread-count')
  @RequirePermissions('notifications:read')
  unreadCount(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenantId: string) {
    return this.notificationsService.unreadCount(user.id, tenantId);
  }

  /**
   * PATCH /notifications/read-all — mark every unread notification as read.
   */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notifications:update')
  markAllAsRead(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenantId: string) {
    return this.notificationsService.markAllAsRead(user.id, tenantId);
  }

  /**
   * PATCH /notifications/:id/read — mark a single notification as read.
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notifications:update')
  markAsRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenantId: string,
  ) {
    return this.notificationsService.markAsRead(id, user.id, tenantId);
  }

  /**
   * POST /notifications — internal route to create a notification.
   * Use `notifications:manage` so only admins / background jobs can trigger this.
   * For module-to-module use: inject NotificationsService directly.
   */
  @Post()
  @RequirePermissions('notifications:manage')
  create(@Body() dto: CreateNotificationDto, @CurrentTenant() tenantId: string) {
    return this.notificationsService.create(dto, tenantId);
  }
}
