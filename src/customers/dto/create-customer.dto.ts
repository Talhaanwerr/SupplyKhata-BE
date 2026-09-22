import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CustomerStatus, PaymentCycle } from '../../common/enums/customer.enum';

export class CustomerProductPriceInputDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 80 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pricePerUnit!: number;
}

export class CreateCustomerDto {
  @ApiProperty({ example: 'Ahmed Store' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'ahmed@store.com' })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed.toLowerCase();
  })
  @ValidateIf((_, v) => v != null && v !== '')
  @IsEmail()
  @MaxLength(191)
  email?: string | null;

  @ApiProperty({ example: '+92 300 1234567' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(40)
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
  @IsString()
  @MaxLength(40)
  secondaryPhone?: string | null;

  @ApiProperty({ example: 'Shop 12, Main Market' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  address!: string;

  @ApiPropertyOptional({ description: 'Existing area id (exactly one of areaId / areaName)' })
  @IsOptional()
  @IsString()
  areaId?: string;

  @ApiPropertyOptional({
    description: 'Create/find area by name (exactly one of areaId / areaName)',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  areaName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
  @IsString()
  @MaxLength(1000)
  locationNotes?: string | null;

  @ApiPropertyOptional({ enum: CustomerStatus, default: CustomerStatus.ACTIVE })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional({ enum: PaymentCycle, default: PaymentCycle.CASH_ON_DELIVERY })
  @IsOptional()
  @IsEnum(PaymentCycle)
  paymentCycle?: PaymentCycle;

  @ApiPropertyOptional({ example: 15, description: 'Day of month 1–31 (MONTHLY / CUSTOM)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  billingDueDate?: number | null;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'ISO date — required for WEEKLY / FORTNIGHTLY',
  })
  @IsOptional()
  @IsDateString()
  billingAnchorDate?: string | null;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingReceivableBalance?: number;

  @ApiPropertyOptional({ example: 0, description: 'Whole number >= 0 (no decimals)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  containerDeposit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultRiderId?: string | null;

  @ApiPropertyOptional({ type: [CustomerProductPriceInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomerProductPriceInputDto)
  customerProductPrices?: CustomerProductPriceInputDto[];
}
