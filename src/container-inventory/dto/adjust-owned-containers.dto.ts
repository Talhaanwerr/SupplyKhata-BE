import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class AdjustOwnedContainersDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ example: 5, description: 'Signed delta for owned fleet; non-zero' })
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
