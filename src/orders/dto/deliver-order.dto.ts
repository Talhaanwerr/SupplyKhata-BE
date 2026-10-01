import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DeliverOrderItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  /**
   * INCREMENTAL quantity delivered in this call (added to OrderItem.quantityDelivered).
   * Not an absolute total — send only the qty handed off now.
   */
  @ApiProperty({
    example: 1,
    description:
      'INCREMENTAL qty to add this call (not absolute remaining). Added onto existing quantityDelivered.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantityDelivered!: number;

  @ApiPropertyOptional({
    example: 2,
    description:
      'INCREMENTAL cans/packaging units given this call (returnable + containers flag). Required for LTR/KG returnable.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  containersDelivered?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'INCREMENTAL empties received this call (returnable + containers flag).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  emptiesReceived?: number;
}

export class DeliverOrderDto {
  @ApiProperty({ type: [DeliverOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DeliverOrderItemDto)
  items!: DeliverOrderItemDto[];
}
