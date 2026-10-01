import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VoidInvoiceDto {
  @ApiProperty({ example: 'Issued in error' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
