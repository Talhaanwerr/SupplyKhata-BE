import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { RawMaterialsController } from './raw-materials.controller';
import { RawMaterialsService } from './raw-materials.service';

@Module({
  imports: [InventoryModule],
  controllers: [RawMaterialsController],
  providers: [RawMaterialsService, PermissionsGuard, TenantGuard],
  exports: [RawMaterialsService],
})
export class RawMaterialsModule {}
