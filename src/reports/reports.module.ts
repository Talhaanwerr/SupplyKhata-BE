import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { ContainerInventoryModule } from '../container-inventory/container-inventory.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [ContainerInventoryModule],
  controllers: [ReportsController],
  providers: [ReportsService, PermissionsGuard, TenantGuard],
  exports: [ReportsService],
})
export class ReportsModule {}
