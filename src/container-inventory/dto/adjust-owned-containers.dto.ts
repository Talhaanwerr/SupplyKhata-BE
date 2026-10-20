import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ContainerMovementType } from '../../common/enums/delivery.enum';

const WRITE_OFF_TYPES = [
  ContainerMovementType.ADJUSTMENT,
  ContainerMovementType.LOST,
  ContainerMovementType.DAMAGED,
] as const;

export class AdjustOwnedContainersDto {
  @ApiProperty({ description: 'Shared packaging type (e.g. 20L Can)' })
  @IsString()
  @MinLength(1)
  packagingTypeId!: string;

  @ApiProperty({
    example: 5,
    description:
      'For ADJUSTMENT: signed delta. For LOST/DAMAGED: positive cans removed from owned fleet.',
  })
  @Type(() => Number)
  @IsInt()
  quantityDelta!: number;

  @ApiPropertyOptional({
    enum: WRITE_OFF_TYPES,
    default: ContainerMovementType.ADJUSTMENT,
  })
  @IsOptional()
  @IsEnum(ContainerMovementType)
  movementType?: (typeof WRITE_OFF_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
