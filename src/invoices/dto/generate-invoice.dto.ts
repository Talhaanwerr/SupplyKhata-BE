import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoicePeriodType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GenerateInvoiceDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  customerId!: string;

  @ApiProperty({ enum: InvoicePeriodType })
  @IsEnum(InvoicePeriodType)
  periodType!: InvoicePeriodType;

  @ApiProperty({
    example: '2026-09-01',
    description: 'Inclusive period start (YYYY-MM-DD, Asia/Karachi date-only)',
  })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({ example: '2026-09-30', description: 'Inclusive period end (YYYY-MM-DD)' })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
