import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PlannedStopStatus } from '@prisma/client';

export class PlannedStopItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  plannedQuantity!: number;
}

export class ListPlannedStopsQueryDto {
  @ApiProperty({ example: '2026-09-25' })
  @IsDateString()
  date!: string;

  @ApiPropertyOptional({ enum: PlannedStopStatus })
  @IsOptional()
  @IsEnum(PlannedStopStatus)
  status?: PlannedStopStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  areaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  riderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}

export class CreateManualPlannedStopDto {
  @ApiProperty({ example: '2026-09-25' })
  @IsDateString()
  planDate!: string;

  @ApiProperty()
  @IsString()
  customerId!: string;

  @ApiProperty({ type: [PlannedStopItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlannedStopItemDto)
  items!: PlannedStopItemDto[];
}

export class UpdatePlannedStopDto {
  @ApiPropertyOptional({ example: '2026-09-26' })
  @IsOptional()
  @IsDateString()
  planDate?: string;

  @ApiPropertyOptional({ type: [PlannedStopItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlannedStopItemDto)
  items?: PlannedStopItemDto[];
}

export class SkipFailPlannedStopDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class IncludePlannedStopsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  plannedStopIds!: string[];
}
