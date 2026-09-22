import { Controller, Get, Query, UseGuards, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { ExportService, toCsv } from './export.service';
import { ExportQueryDto } from './dto/export-query.dto';

function makeFile(
  data: Record<string, unknown>[],
  format: 'csv' | 'json' = 'csv',
  filename: string,
  res: Response,
  emptyCsvHeaders?: string[],
): StreamableFile {
  let content: string;
  let mimeType: string;

  if (format === 'json') {
    content = JSON.stringify(data, null, 2);
    mimeType = 'application/json';
    filename = filename.replace('.csv', '.json');
  } else {
    content = toCsv(data, emptyCsvHeaders);
    mimeType = 'text/csv';
  }

  const buffer = Buffer.from(content, 'utf-8');

  res.set({
    'Content-Type': `${mimeType}; charset=utf-8`,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length.toString(),
  });

  return new StreamableFile(buffer);
}

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'export', version: '1' })
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  /**
   * GET /api/v1/export/users?format=csv|json
   * Downloads all workspace members as a file (GDPR data export).
   */
  @Get('users')
  @RequirePermissions('users:read')
  async exportUsers(
    @Query() query: ExportQueryDto,
    @CurrentTenant() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.exportService.exportUsers(tenantId);
    const stamp = new Date().toISOString().slice(0, 10);
    return makeFile(rows, query.format ?? 'csv', `users-${stamp}.csv`, res, [
      'id',
      'email',
      'firstName',
      'lastName',
      'status',
      'emailVerified',
      'timezone',
      'avatarUrl',
      'joinedAt',
      'memberSince',
    ]);
  }

  /**
   * GET /api/v1/export/audit-logs?format=csv|json
   * Downloads tenant audit log history (up to 10,000 most recent entries).
   */
  @Get('audit-logs')
  @RequirePermissions('audit-logs:read')
  async exportAuditLogs(
    @Query() query: ExportQueryDto,
    @CurrentTenant() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.exportService.exportAuditLogs(tenantId);
    const stamp = new Date().toISOString().slice(0, 10);
    return makeFile(rows, query.format ?? 'csv', `audit-logs-${stamp}.csv`, res, [
      'id',
      'module',
      'action',
      'entityId',
      'actorEmail',
      'actorName',
      'oldValue',
      'newValue',
      'ipAddress',
      'createdAt',
    ]);
  }
}
