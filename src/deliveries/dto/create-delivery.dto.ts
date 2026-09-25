import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '../../common/enums/delivery.enum';

export class CreateDeliveryItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 3, description: 'Quantity in product baseUnit (PCS / LTR / KG)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  quantityDelivered!: number;

  @ApiPropertyOptional({ example: 2, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  emptiesReceived?: number;
}

export class CreateDeliveryDto {
  @ApiProperty()
  @IsString()
  deliveryRunId!: string;

  @ApiProperty()
  @IsString()
  customerId!: string;

  @ApiProperty({ example: '2026-09-19' })
  @IsDateString()
  deliveryDate!: string;

  @ApiPropertyOptional({ enum: PaymentMethod, default: PaymentMethod.CASH })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cashReceived?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({ example: '2026-09-15', description: 'Customer promised pay date' })
  @IsOptional()
  @IsDateString()
  promisedPayDate?: string;

  @ApiPropertyOptional({
    example: 100,
    description: 'Optional promised collection amount (no ledger entry)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  promisedAmount?: number;

  @ApiPropertyOptional({
    description: 'When set, marks this planned stop COMPLETED and advances the schedule cadence',
  })
  @IsOptional()
  @IsString()
  plannedStopId?: string;

  @ApiProperty({ type: [CreateDeliveryItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateDeliveryItemDto)
  items!: CreateDeliveryItemDto[];
}
