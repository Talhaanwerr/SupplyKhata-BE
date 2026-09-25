import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { ContainerInventoryController } from './container-inventory.controller';
import { ContainerInventoryService } from './container-inventory.service';

@Module({
  controllers: [ContainerInventoryController],
  providers: [ContainerInventoryService, PermissionsGuard, TenantGuard],
  exports: [ContainerInventoryService],
})
export class ContainerInventoryModule {}
