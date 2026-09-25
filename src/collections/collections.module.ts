import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PaymentsModule } from '../payments/payments.module';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';

@Module({
  imports: [PaymentsModule],
  controllers: [CollectionsController],
  providers: [CollectionsService, PermissionsGuard, TenantGuard],
  exports: [CollectionsService],
})
export class CollectionsModule {}
