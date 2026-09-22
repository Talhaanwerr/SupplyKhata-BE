import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'users' })
  @IsOptional()
  @IsString()
  module?: string;

  @ApiPropertyOptional({ example: 'CREATE' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ example: 'user-cuid' })
  @IsOptional()
  @IsString()
  userId?: string;

  /** Free-text search across module, action, entityId, and actor email/name. */
  @ApiPropertyOptional({ example: 'invite' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  /** Visible to super admin only — silently ignored for tenant users. */
  @ApiPropertyOptional({ example: 'tenant-cuid' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.999Z' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
