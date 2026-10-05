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

export class OpeningStockLineDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ description: 'Quantity > 0 (base units)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;
}

export class PostOpeningStockDto {
  @ApiPropertyOptional({
    description: 'Defaults to the single/default location when warehouse flag is OFF',
  })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty({ type: [OpeningStockLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OpeningStockLineDto)
  lines!: OpeningStockLineDto[];
}

export class PostAdjustmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty()
  @IsString()
  productId!: string;

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

export class PostTransferDto {
  @ApiProperty()
  @IsString()
  fromLocationId!: string;

  @ApiProperty()
  @IsString()
  toLocationId!: string;

  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ description: 'Quantity > 0 to move from → to' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;
}
