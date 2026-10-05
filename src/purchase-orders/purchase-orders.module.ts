import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { VendorBillsModule } from '../vendor-bills/vendor-bills.module';
import { GoodsReceiptsController, PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { GoodsReceiptsService } from './goods-receipts.service';

@Module({
  imports: [InventoryModule, VendorBillsModule],
  controllers: [PurchaseOrdersController, GoodsReceiptsController],
  providers: [PurchaseOrdersService, GoodsReceiptsService, PermissionsGuard, TenantGuard],
  exports: [PurchaseOrdersService, GoodsReceiptsService],
})
export class PurchaseOrdersModule {}
