import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

@Module({
  imports: [InventoryModule],
  controllers: [ProductionController],
  providers: [ProductionService, PermissionsGuard, TenantGuard],
  exports: [ProductionService],
})
export class ProductionModule {}
