import { Module } from '@nestjs/common';
import { PackagingTypesService } from './packaging-types.service';
import { PackagingTypesController } from './packaging-types.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [PackagingTypesController],
  providers: [PackagingTypesService, PermissionsGuard, TenantGuard],
  exports: [PackagingTypesService],
})
export class PackagingTypesModule {}
