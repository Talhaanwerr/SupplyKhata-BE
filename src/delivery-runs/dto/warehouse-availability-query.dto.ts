import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class WarehouseAvailabilityQueryDto {
  @ApiPropertyOptional({ description: 'Stock location; defaults to Main when omitted' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional({
    description:
      'When editing a run opening, add back that run’s prior TRANSFER_OUT so available qty includes stock already on the truck',
  })
  @IsOptional()
  @IsString()
  excludeRunId?: string;
}
