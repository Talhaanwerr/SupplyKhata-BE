import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { VendorBillsController } from './vendor-bills.controller';
import { VendorBillsService } from './vendor-bills.service';

@Module({
  controllers: [VendorBillsController],
  providers: [VendorBillsService, PermissionsGuard, TenantGuard],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
