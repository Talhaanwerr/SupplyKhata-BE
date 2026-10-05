import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StockLocationType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateStockLocationDto {
  @ApiProperty({ example: 'Plant A' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: StockLocationType, default: StockLocationType.WAREHOUSE })
  @IsOptional()
  @IsEnum(StockLocationType)
  type?: StockLocationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  notes?: string;
}

export class UpdateStockLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: StockLocationType })
  @IsOptional()
  @IsEnum(StockLocationType)
  type?: StockLocationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
