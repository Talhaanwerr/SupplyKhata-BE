import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { MemberStatus } from '../../common/enums/user-status.enum';

export class ListStaffQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by system role slug (e.g. rider / RIDER)',
    example: 'RIDER',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(50)
  role?: string;

  @ApiPropertyOptional({ enum: MemberStatus })
  @IsOptional()
  @IsEnum(MemberStatus)
  status?: MemberStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}
