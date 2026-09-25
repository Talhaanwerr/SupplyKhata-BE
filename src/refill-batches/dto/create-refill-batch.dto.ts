import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateRefillBatchDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ example: '2026-09-24' })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cansFilledCount!: number;

  @ApiProperty({ example: 25.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPerUnit!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
