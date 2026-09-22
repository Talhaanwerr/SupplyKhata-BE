import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { VehicleStatus } from '../../common/enums/vehicle.enum';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListVehiclesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search by name, plate, or type' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: VehicleStatus })
  @IsOptional()
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
}
