import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryRunStockDto } from './delivery-run-stock.dto';

export class CreateDeliveryRunDto {
  @ApiProperty()
  @IsString()
  riderId!: string;

  @ApiProperty()
  @IsString()
  vehicleId!: string;

  @ApiProperty({ example: '2026-09-19' })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingCash!: number;

  @ApiProperty({ type: [DeliveryRunStockDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DeliveryRunStockDto)
  openingStock!: DeliveryRunStockDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
