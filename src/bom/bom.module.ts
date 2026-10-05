import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { BomController } from './bom.controller';
import { BomService } from './bom.service';

@Module({
  controllers: [BomController],
  providers: [BomService, PermissionsGuard, TenantGuard],
  exports: [BomService],
})
export class BomModule {}
