import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ReturnToWarehouseLineDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 5, description: 'Filled units to return to warehouse (≤ leftover)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  qty!: number;
}
