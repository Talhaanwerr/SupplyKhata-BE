import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class ApplyOrderPaymentDto {
  @ApiProperty({ example: 'clxyz...' })
  @IsString()
  @MinLength(1)
  paymentId!: string;

  @ApiProperty({ example: 500 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;
}
