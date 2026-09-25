import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';

@Module({
  imports: [SchedulingModule],
  controllers: [DeliveriesController],
  providers: [DeliveriesService, PermissionsGuard, TenantGuard],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
