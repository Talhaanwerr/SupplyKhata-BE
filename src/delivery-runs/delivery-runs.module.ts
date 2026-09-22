import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { DeliveryRunsController } from './delivery-runs.controller';
import { DeliveryRunsService } from './delivery-runs.service';

@Module({
  controllers: [DeliveryRunsController],
  providers: [DeliveryRunsService, PermissionsGuard, TenantGuard],
  exports: [DeliveryRunsService],
})
export class DeliveryRunsModule {}
