import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { VendorBillsModule } from '../vendor-bills/vendor-bills.module';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';

@Module({
  imports: [VendorBillsModule],
  controllers: [VendorsController],
  providers: [VendorsService, PermissionsGuard, TenantGuard],
  exports: [VendorsService],
})
export class VendorsModule {}
