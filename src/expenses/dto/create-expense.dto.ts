import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaymentMethod } from '../../common/enums/delivery.enum';

export class CreateExpenseDto {
  @ApiProperty({ example: 'Petrol' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ example: '2026-09-24' })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 1500.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deliveryRunId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  staffId?: string | null;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsString()
  @MaxLength(120)
  reference?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPaidByRider?: boolean;
}
