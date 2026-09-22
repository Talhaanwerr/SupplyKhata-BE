import { Global, Module } from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogsController } from './audit-logs.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { TenantGuard } from '../common/guards/tenant.guard';

@Global()
@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsService, PermissionsGuard, TenantGuard],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
