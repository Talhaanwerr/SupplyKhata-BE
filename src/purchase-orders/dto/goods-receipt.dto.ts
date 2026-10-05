import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class GoodsReceiptLineInputDto {
  @ApiProperty()
  @IsString()
  purchaseOrderLineId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  qtyReceived!: number;
}

export class CreateGoodsReceiptDto {
  @ApiPropertyOptional({ description: 'Defaults to Main / single location when omitted' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty()
  @IsDateString()
  receiptDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  /** Due date for the auto-created vendor bill (when vendor-bills is enabled). */
  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsDateString()
  billDueDate?: string | null;

  @ApiProperty({ type: [GoodsReceiptLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptLineInputDto)
  lines!: GoodsReceiptLineInputDto[];
}

export class ListGoodsReceiptsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purchaseOrderId?: string;
}
