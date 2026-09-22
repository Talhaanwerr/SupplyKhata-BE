import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, PermissionsGuard, TenantGuard],
  exports: [NotificationsService],
})
export class NotificationsModule {}
