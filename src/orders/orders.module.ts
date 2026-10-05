import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [InventoryModule],
  controllers: [OrdersController],
  providers: [OrdersService, PermissionsGuard, TenantGuard],
  exports: [OrdersService],
})
export class OrdersModule {}
