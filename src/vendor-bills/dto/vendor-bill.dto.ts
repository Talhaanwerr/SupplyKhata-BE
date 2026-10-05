import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, VendorBillStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class VendorBillLineInputDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  description!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  qty!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCost!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purchaseOrderLineId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  goodsReceiptLineId?: string | null;
}

export class CreateVendorBillDto {
  @ApiProperty()
  @IsString()
  vendorId!: string;

  @ApiProperty()
  @IsDateString()
  billDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purchaseOrderId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  goodsReceiptId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiProperty({ type: [VendorBillLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VendorBillLineInputDto)
  lines!: VendorBillLineInputDto[];
}

export class PayVendorBillDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty()
  @IsDateString()
  paymentDate!: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class VoidVendorBillDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class CreateBillFromGoodsReceiptDto {
  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

export class UpdateVendorBillDueDateDto {
  @ApiProperty({ example: '2026-10-15' })
  @IsDateString()
  dueDate!: string;
}

export class ListVendorLedgerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ListVendorDuesQueryDto {
  /** Calendar day — bills due on or before this date (default: today). */
  @ApiPropertyOptional({ example: '2026-10-04' })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class ListVendorBillsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purchaseOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  goodsReceiptId?: string;

  @ApiPropertyOptional({ enum: VendorBillStatus })
  @IsOptional()
  @IsEnum(VendorBillStatus)
  status?: VendorBillStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
