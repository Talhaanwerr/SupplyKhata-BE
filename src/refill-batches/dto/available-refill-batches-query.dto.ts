import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class AvailableRefillBatchesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;
}
