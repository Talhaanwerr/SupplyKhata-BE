import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryRunStockDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  filledCount!: number;

  @ApiProperty({ example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  emptyCount!: number;
}
