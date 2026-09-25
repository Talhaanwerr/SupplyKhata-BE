import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ContainerOpeningItemDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ example: 60, description: 'Absolute owned fleet opening for this product' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantity!: number;
}

export class SetContainerOpeningDto {
  @ApiProperty({ type: [ContainerOpeningItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ContainerOpeningItemDto)
  items!: ContainerOpeningItemDto[];
}
