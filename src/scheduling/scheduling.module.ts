import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SchedulingService } from './scheduling.service';
import { DeliverySchedulesController } from './delivery-schedules.controller';
import { PlannedStopsController } from './planned-stops.controller';

@Module({
  imports: [AuditLogsModule],
  controllers: [DeliverySchedulesController, PlannedStopsController],
  providers: [SchedulingService, PermissionsGuard, TenantGuard],
  exports: [SchedulingService],
})
export class SchedulingModule {}
