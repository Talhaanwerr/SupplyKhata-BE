import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductionOrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class CreateProductionOrderDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiPropertyOptional({ description: 'Defaults to active BOM for product' })
  @IsOptional()
  @IsString()
  bomId?: string;

  @ApiPropertyOptional({ description: 'Defaults to Main location when omitted' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  plannedQty!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateProductionOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bomId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  plannedQty?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class CancelProductionOrderDto {
  @ApiPropertyOptional({ description: 'Required when status is IN_PROGRESS' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CompleteProductionOrderDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  actualQty!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  scrapQty?: number | null;

  @ApiPropertyOptional({ description: 'Required when actualQty ≠ plannedQty' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  varianceNote?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  scrapReason?: string | null;
}

export class ListProductionOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({ enum: ProductionOrderStatus })
  @IsOptional()
  @IsEnum(ProductionOrderStatus)
  status?: ProductionOrderStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
