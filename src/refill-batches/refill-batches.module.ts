import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { RefillBatchesController } from './refill-batches.controller';
import { RefillBatchesService } from './refill-batches.service';

@Module({
  controllers: [RefillBatchesController],
  providers: [RefillBatchesService, PermissionsGuard, TenantGuard],
  exports: [RefillBatchesService],
})
export class RefillBatchesModule {}
