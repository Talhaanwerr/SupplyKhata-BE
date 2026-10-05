import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryRunStockDto } from './delivery-run-stock.dto';
import { ReturnToWarehouseLineDto } from './return-to-warehouse-line.dto';

export class CloseDeliveryRunDto {
  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  closingCash!: number;

  @ApiProperty({ type: [DeliveryRunStockDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DeliveryRunStockDto)
  closingStock!: DeliveryRunStockDto[];

  /**
   * Optional leftover return when inventory ON.
   * Partial OK; qty ≤ leftover (opening − delivered). No auto-return if omitted.
   */
  @ApiPropertyOptional({ type: [ReturnToWarehouseLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReturnToWarehouseLineDto)
  returnToWarehouse?: ReturnToWarehouseLineDto[];
}
