import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class RawOpeningLineDto {
  @ApiProperty()
  @IsString()
  rawMaterialId!: string;

  @ApiProperty({ description: 'Quantity > 0' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;
}

export class PostRawOpeningDto {
  @ApiPropertyOptional({
    description: 'Defaults to the single/default location when warehouse flag is OFF',
  })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty({ type: [RawOpeningLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RawOpeningLineDto)
  lines!: RawOpeningLineDto[];
}

export class PostRawAdjustmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty()
  @IsString()
  rawMaterialId!: string;

  @ApiProperty({
    description: 'Signed delta (+ found / − damage). Resulting balance must be ≥ 0.',
  })
  @Type(() => Number)
  @IsNumber()
  quantityDelta!: number;

  @ApiProperty({ example: 'Count fix / damage / loss / found' })
  @IsString()
  reason!: string;
}
