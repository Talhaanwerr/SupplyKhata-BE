import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ResolveCustomerPriceQueryDto {
  @ApiProperty({ description: 'Product id to resolve price for' })
  @IsString()
  productId!: string;
}
