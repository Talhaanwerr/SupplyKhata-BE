import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, PermissionsGuard, TenantGuard],
  exports: [ProductsService],
})
export class ProductsModule {}
