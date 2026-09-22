import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { TenantStatus } from '../../common/enums/tenant-status.enum';

export class ListTenantsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'acme' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: TenantStatus })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}
