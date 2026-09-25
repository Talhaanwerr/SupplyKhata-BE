import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateCashHandoverDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  riderId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  receivedById!: string;

  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiProperty({ example: '2026-09-24' })
  @IsDateString()
  handoverDate!: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deliveryRunId?: string | null;
}
