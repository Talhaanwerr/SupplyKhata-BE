import { Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagsController } from './feature-flags.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [FeatureFlagsController],
  providers: [FeatureFlagsService, PermissionsGuard, TenantGuard],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
