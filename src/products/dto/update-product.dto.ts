import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ProductBaseUnit } from '../../common/enums/product.enum';

export class UpdateProductDto {
  @ApiPropertyOptional({ example: '19L Can' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: ProductBaseUnit })
  @IsOptional()
  @IsEnum(ProductBaseUnit)
  baseUnit?: ProductBaseUnit;

  @ApiPropertyOptional({ example: 19, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  volume?: number | null;

  @ApiPropertyOptional({ example: 'L', nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(20)
  unit?: string | null;

  @ApiPropertyOptional({ example: 'CAN-19L', nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  sku?: string | null;

  @ApiPropertyOptional({ example: 250, description: 'Price per base unit' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultSellingPrice?: number;

  @ApiPropertyOptional({ example: 12, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  unitsPerPack?: number | null;

  @ApiPropertyOptional({ example: 'CTN', nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(40)
  packLabel?: string | null;

  @ApiPropertyOptional({ example: 20, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  containerCapacity?: number | null;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  allowFractionalQty?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isReturnable?: boolean;

  @ApiPropertyOptional({ example: 'CAN_19L', nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  containerType?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
