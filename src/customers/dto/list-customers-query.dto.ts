import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CustomerStatus } from '../../common/enums/customer.enum';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search by name or phone (alias of q)' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({ description: 'Search by name or phone (alias of search)' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  q?: string;

  @ApiPropertyOptional({ enum: CustomerStatus })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  areaId?: string;
}
