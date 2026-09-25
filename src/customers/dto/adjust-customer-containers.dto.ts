import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class AdjustCustomerContainersDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ example: 1, description: 'Signed delta; non-zero' })
  @Type(() => Number)
  @IsInt()
  quantityDelta!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
