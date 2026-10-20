import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [NotificationsModule],
  controllers: [InventoryController],
  providers: [InventoryService, PermissionsGuard, TenantGuard],
  exports: [InventoryService],
})
export class InventoryModule {}
