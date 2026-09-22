import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [VehiclesController],
  providers: [VehiclesService, PermissionsGuard, TenantGuard],
  exports: [VehiclesService],
})
export class VehiclesModule {}
