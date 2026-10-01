import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';

/** v1: FULL refund only — amount must equal order.amountPaid. */
export class RefundOrderDto {
  @ApiProperty({
    example: 1500,
    description: 'Must equal current amountPaid (full refund only in v1)',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiProperty({ example: 'Customer returned goods' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
