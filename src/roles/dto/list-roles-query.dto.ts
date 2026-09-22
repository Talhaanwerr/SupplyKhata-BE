import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListRolesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'billing' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
