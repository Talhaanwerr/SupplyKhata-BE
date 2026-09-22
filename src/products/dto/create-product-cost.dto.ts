import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductCostDto {
  @ApiProperty({ example: 180 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPerUnit!: number;

  @ApiPropertyOptional({
    description: 'ISO date when this cost becomes effective. Defaults to now.',
    example: '2026-09-17',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({ example: 'Refill rate increased' })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  notes?: string | null;
}
