import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Module({
  controllers: [ExportController],
  providers: [ExportService, PermissionsGuard, TenantGuard],
})
export class ExportModule {}
