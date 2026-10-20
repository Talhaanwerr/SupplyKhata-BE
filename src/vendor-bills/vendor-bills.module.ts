import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { VendorBillsController } from './vendor-bills.controller';
import { VendorBillsService } from './vendor-bills.service';

@Module({
  imports: [NotificationsModule],
  controllers: [VendorBillsController],
  providers: [VendorBillsService, PermissionsGuard, TenantGuard],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
