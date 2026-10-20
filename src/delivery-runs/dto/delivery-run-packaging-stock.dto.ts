import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryRunPackagingStockDto {
  @ApiProperty({ description: 'Shared packaging type (e.g. 20L Can)' })
  @IsString()
  @MinLength(1)
  packagingTypeId!: string;

  @ApiProperty({ example: 10, description: 'Filled cans on truck for this packaging type' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  filledCount!: number;

  @ApiProperty({ example: 2, description: 'Empty cans on truck for this packaging type' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  emptyCount!: number;
}
