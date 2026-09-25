import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '../../common/enums/delivery.enum';
import { CollectionVisitOutcome } from '../../common/enums/collection.enum';

export class RecordCollectionVisitDto {
  @ApiProperty({ enum: CollectionVisitOutcome })
  @IsEnum(CollectionVisitOutcome)
  outcome!: CollectionVisitOutcome;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @ValidateIf((o: RecordCollectionVisitDto) => o.amount != null && o.amount > 0)
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  promiseDate?: string;

  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  promiseAmount?: number;

  @ApiPropertyOptional({ example: '2026-09-28' })
  @IsOptional()
  @IsDateString()
  followUpDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({ example: '2026-09-25', description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  visitDate?: string;
}
