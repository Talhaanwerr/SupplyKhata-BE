import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ProductBaseUnit } from '../../common/enums/product.enum';

export class CreateProductDto {
  @ApiProperty({ example: '19L Can' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: ProductBaseUnit, example: ProductBaseUnit.PCS })
  @IsEnum(ProductBaseUnit)
  baseUnit!: ProductBaseUnit;

  @ApiPropertyOptional({ example: 19 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  volume?: number | null;

  @ApiPropertyOptional({ example: 'L', default: 'L' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(20)
  unit?: string | null;

  @ApiPropertyOptional({ example: 'CAN-19L' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  sku?: string | null;

  @ApiProperty({ example: 250, description: 'Price per base unit (PCS / LTR / KG)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultSellingPrice!: number;

  @ApiPropertyOptional({ example: 12, description: 'Bottles/pieces per pack (CTN/crate helper)' })
  @IsOptional()
  @ValidateIf((_, o) => o.unitsPerPack != null || (o.packLabel != null && o.packLabel !== ''))
  @Type(() => Number)
  @IsInt()
  @Min(2)
  unitsPerPack?: number | null;

  @ApiPropertyOptional({ example: 'CTN' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(40)
  packLabel?: string | null;

  @ApiPropertyOptional({
    example: 20,
    description: 'Packaging capacity only (e.g. 20L can) — not the sale quantity',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  containerCapacity?: number | null;

  @ApiPropertyOptional({
    example: false,
    description: 'Defaults true for LTR/KG, false for PCS when omitted',
  })
  @IsOptional()
  @IsBoolean()
  allowFractionalQty?: boolean;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isReturnable?: boolean;

  @ApiPropertyOptional({ example: 'CAN_19L' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  containerType?: string | null;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Optional initial cost recorded on create (effective today). */
  @ApiPropertyOptional({ example: 180 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  initialCostPerUnit?: number;
}
