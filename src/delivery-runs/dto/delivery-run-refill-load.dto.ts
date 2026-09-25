import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryRunRefillLoadDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  refillBatchId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantityLoaded!: number;
}
