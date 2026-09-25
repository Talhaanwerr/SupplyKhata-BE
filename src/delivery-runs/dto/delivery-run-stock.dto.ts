import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsString, Min } from 'class-validator';
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

  @ApiProperty({ example: 5, description: 'Whole empty packaging units on vehicle' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  emptyCount!: number;
}
