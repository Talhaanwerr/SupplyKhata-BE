import { Controller, Get, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { AuditLogsService } from './audit-logs.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'audit-logs', version: '1' })
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  /**
   * GET /api/v1/audit-logs
   * - Super admin: platform-level SA activity (optional tenantId filter)
   * - Tenant user: scoped to active tenant (TenantGuard / JWT tenantId)
   */
  @Get()
  @RequirePermissions('audit-logs:read')
  findAll(
    @Query() query: ListAuditLogsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request & { tenantId?: string | null },
  ) {
    if (user.isSuperAdmin) {
      return this.auditLogsService.findAll(query, query.tenantId ?? null, true);
    }

    const tenantId = req.tenantId ?? user.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context is missing');
    }
    return this.auditLogsService.findAll(query, tenantId, false);
  }
}
