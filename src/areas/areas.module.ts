import { Module } from '@nestjs/common';
import { AreasService } from './areas.service';
import { AreasController } from './areas.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [AreasController],
  providers: [AreasService, PermissionsGuard, TenantGuard],
  exports: [AreasService],
})
export class AreasModule {}
