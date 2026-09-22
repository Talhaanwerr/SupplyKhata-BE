import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RunStatus } from '../../common/enums/delivery.enum';

export class ListDeliveryRunsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  riderId?: string;

  @ApiPropertyOptional({ enum: RunStatus })
  @IsOptional()
  @IsEnum(RunStatus)
  status?: RunStatus;
}
