import { ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { CreateCustomerDto } from './create-customer.dto';

export class UpdateCustomerDto extends PartialType(OmitType(CreateCustomerDto, [] as const)) {
  @ApiPropertyOptional({ description: 'Existing area id' })
  @IsOptional()
  @IsString()
  areaId?: string;

  @ApiPropertyOptional({ description: 'Create/find area by name' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  areaName?: string;
}
