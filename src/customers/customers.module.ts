import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, PermissionsGuard, TenantGuard],
  exports: [CustomersService],
})
export class CustomersModule {}
