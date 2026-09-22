import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';

@Module({
  controllers: [DeliveriesController],
  providers: [DeliveriesService, PermissionsGuard, TenantGuard],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
