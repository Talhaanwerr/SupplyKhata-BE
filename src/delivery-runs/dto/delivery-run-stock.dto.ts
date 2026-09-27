import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryRunStockDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 20, description: 'Units in product baseUnit (cans / L / kg)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  filledCount!: number;

  @ApiPropertyOptional({
    example: 3,
    description:
      'Filled cans on vehicle. Required for returnable LTR/KG when filledCount > 0 (e.g. 40L in 3 cans).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  filledPackagingCount?: number;

  @ApiProperty({ example: 5, description: 'Whole empty packaging units on vehicle' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  emptyCount!: number;
}
